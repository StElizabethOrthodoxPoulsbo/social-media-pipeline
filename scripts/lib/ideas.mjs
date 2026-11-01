import { randomUUID } from 'node:crypto';
import { hashInput, publicUrl } from './compose.mjs';
import { PLACEHOLDER_PATTERN, postAttachments, postImages, setFields, validatePost } from './posts.mjs';
import { parsePublishAt } from './time.mjs';

export function composeIdeaInput(post, organizationId, config) {
  const invalid = validatePost(post, config, { forIdeas: true }).errors;
  if (invalid.length) throw new Error(invalid.join('; '));
  if (!post.body.trim()) throw new Error('Ideas export needs a caption');
  if (/<!--/.test(post.body) || /<!--/.test(post.data.title) || PLACEHOLDER_PATTERN.test(post.body)
    || PLACEHOLDER_PATTERN.test(post.data.title)) {
    throw new Error('Remove HTML comments and TODO(agent) placeholders before sending to Ideas');
  }
  let text = post.body.trim();
  if (post.data.link) text += `\n\n${post.data.link}`;
  for (const attachment of postAttachments(post)) {
    text += `\n\n${attachment.label || 'Download'}: ${publicUrl(attachment.file, config)}`;
  }
  return {
    organizationId,
    content: {
      title: post.data.title,
      text,
      date: parsePublishAt(post.data.publish_at, config.timezone).toISOString(),
      media: postImages(post).map((image) => ({
        url: publicUrl(image.image, config),
        type: 'image',
        ...(image.alt ? { alt: String(image.alt) } : {}),
      })),
    },
  };
}

export async function resolveIdeaOrganization(client, config) {
  const organizations = await client.organizations();
  const configured = config.buffer.organization_id;
  if (configured) {
    if (!organizations.some((org) => org.id === configured)) {
      throw new Error('buffer.organization_id is not accessible to this Buffer API key');
    }
    return configured;
  }
  if (organizations.length !== 1) {
    throw new Error(`Buffer has ${organizations.length} accessible organizations. Set buffer.organization_id in config/pipeline.yml; use npm run buffer:channels to list IDs.`);
  }
  return organizations[0].id;
}

/** One-way snapshot export, deliberately independent of social post status/state. */
export async function syncIdeas({
  posts, state, config, client, checkMedia = async () => [], checkpoint,
  now = new Date(), dryRun = false, log = () => {},
}) {
  const changed = new Set();
  const actions = [];
  const failures = [];
  let organization;
  const message = (post, text) => {
    if (post.data.buffer_idea_message === text) return;
    setFields(post, { buffer_idea_message: text });
    changed.add(post);
  };
  const persist = async (post) => {
    if (!checkpoint) throw new Error('Ideas creation requires a durable checkpoint before calling Buffer');
    await checkpoint(post);
  };
  for (const post of posts) {
    let key = post.data.buffer_idea_key;
    const previousExports = Object.entries(state.ideas ?? {}).filter(([, entry]) =>
      entry.file === post.file || entry.filenames?.includes(post.file));
    // An editor may save a stale form that predates the generated key/ID.
    // Retained filename evidence must still prevent duplicate creation.
    if (!state.ideas?.[key] && previousExports.length) {
      if (previousExports.length !== 1) {
        message(post, 'Multiple export records match this file. Restore its correct export key; automatic creation is blocked.');
        failures.push(post.file);
        continue;
      }
      key = previousExports[0][0];
      setFields(post, { buffer_idea_key: key });
      changed.add(post);
    }
    const entry = key ? state.ideas?.[key] : undefined;
    if (entry) {
      entry.filenames = [...new Set([...(entry.filenames ?? []), entry.file, post.file])];
      entry.file = post.file;
    }
    if (entry && (!['pending', 'uncertain', 'error', 'exported'].includes(entry.status)
      || (entry.status === 'exported' && !entry.id)
      || (entry.status === 'error' && entry.id))) {
      setFields(post, { buffer_idea_state: 'uncertain' });
      changed.add(post);
      message(post, 'Export ledger is inconsistent. Restore its actual Idea ID/state; automatic creation is blocked.');
      failures.push(post.file);
      continue;
    }
    if (entry?.status === 'exported') {
      setFields(post, { buffer_idea_id: entry.id, buffer_idea_state: 'exported' });
      changed.add(post);
      let edited = false;
      try {
        edited = hashInput(composeIdeaInput(post, entry.organizationId, config)) !== entry.hash;
      } catch {
        edited = true;
      }
      message(post, `Exported to Buffer Ideas (${entry.id}). Not scheduled or published.${
        edited ? ' Content changed; update the existing Idea manually in Buffer.' : ''
      }${post.data.send_to_buffer_ideas !== true || ['published', 'canceled'].includes(post.data.status)
        ? ' The exported Idea is retained; delete it manually in Buffer if unwanted.' : ''}`);
      continue;
    }
    if (entry?.status === 'pending' || entry?.status === 'uncertain') {
      setFields(post, { buffer_idea_state: 'uncertain' });
      changed.add(post);
      message(post, entry.message || 'Creation outcome unknown. Check Buffer Ideas before retrying; automatic creation is blocked to prevent duplicates.');
      failures.push(post.file);
      continue;
    }
    if (post.data.send_to_buffer_ideas !== true || ['published', 'canceled'].includes(post.data.status)) continue;
    // A visible ID without its ledger must not cause a second creation.
    if (post.data.buffer_idea_id) {
      message(post, 'An Idea ID exists but its export ledger is missing. Restore state/buffer.json; automatic export is blocked.');
      failures.push(post.file);
      continue;
    }
    let input;
    try {
      // Validate content before making even a read-only API call.
      composeIdeaInput(post, 'validation-only', config);
      organization ??= dryRun ? (config.buffer.organization_id || 'dry-run-organization')
        : await resolveIdeaOrganization(client, config);
      input = composeIdeaInput(post, organization, config);
      const urls = [...input.content.media.map((media) => media.url),
        ...postAttachments(post).map((attachment) => publicUrl(attachment.file, config))];
      const unreachable = await checkMedia(urls);
      if (unreachable.length) throw new Error(`Media not reachable (${unreachable.join(', ')}); export will retry after Pages deploys`);
    } catch (err) {
      const text = `Ideas export failed: ${String(err.message).replaceAll(client.apiKey || '\0', '[redacted]')}`;
      setFields(post, { buffer_idea_state: 'error' });
      changed.add(post);
      message(post, text);
      failures.push(post.file);
      continue;
    }
    if (dryRun) {
      log(`would create Buffer Idea for ${post.file} in organization ${organization}`);
      actions.push({ type: 'preview', file: post.file });
      continue;
    }
    const exportKey = key || randomUUID();
    state.ideas ??= {};
    state.ideas[exportKey] = {
      file: post.file, filenames: entry?.filenames ?? [post.file], status: 'pending', organizationId: organization,
      hash: hashInput(input), attemptedAt: now.toISOString(),
    };
    setFields(post, { buffer_idea_key: exportKey, buffer_idea_state: 'pending' });
    message(post, 'Creating Buffer Idea. If interrupted, check Buffer before retrying; automatic replay is blocked.');
    await persist(post);
    let result;
    try {
      result = await client.createIdea(input);
      if (!result?.id) throw new Error('Buffer returned no Idea ID');
    } catch (err) {
      const status = err.definiteRejection ? 'error' : 'uncertain';
      const text = `Ideas export ${status === 'uncertain' ? 'outcome unknown' : 'rejected'}: ${
        String(err.message).replaceAll(client.apiKey || '\0', '[redacted]')
      }.${status === 'uncertain' ? ' Check Buffer Ideas; automatic retry is blocked to prevent duplicates.' : ' Will retry on the next workflow run.'}`;
      Object.assign(state.ideas[exportKey], { status, message: text });
      setFields(post, { buffer_idea_state: status });
      message(post, text);
      await persist(post);
      failures.push(post.file);
      continue;
    }
    Object.assign(state.ideas[exportKey], {
      status: 'exported', id: result.id, exportedAt: now.toISOString(),
    });
    setFields(post, { buffer_idea_id: result.id, buffer_idea_state: 'exported' });
    message(post, `Exported to Buffer Ideas (${result.id}). Not scheduled or published.`);
    await persist(post);
    actions.push({ type: 'create-idea', file: post.file, id: result.id });
    log(`create Idea ${post.file} -> ${result.id}`);
  }
  return { changed, actions, failures };
}
