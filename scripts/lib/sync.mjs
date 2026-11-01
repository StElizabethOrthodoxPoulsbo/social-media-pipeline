import { composeBufferInput, hashInput, mediaUrls, toEditInput } from './compose.mjs';
import {
  ACTIVE_STATUSES,
  expectedFilename,
  postChannels,
  setFields,
  validatePost,
} from './posts.mjs';
import { DAY_MS, localDate, parsePublishAt } from './time.mjs';

/** Posts must be scheduled at least this far in the future. */
export const MIN_LEAD_MS = 5 * 60_000;

/**
 * Reconcile Markdown posts with Buffer.
 *
 * state shape: { posts: { "<file>.md": { "<channel>": { id, hash, dueAt, status, externalLink } } } }
 *
 * Mutates `posts` (file names / front matter) and `state` in place and returns
 * a summary describing what changed so the caller can persist it.
 */
export async function syncPosts({
  posts,
  archivedPosts = [],
  state,
  config,
  client,
  now = new Date(),
  checkPublished = false,
  checkMedia = async () => [],
  log = () => {},
}) {
  state.posts ??= {};
  const changed = new Set();
  const renames = [];
  const actions = [];
  let halted = null;

  const call = async (fn) => {
    if (halted) throw halted;
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'RATE_LIMIT_EXCEEDED' || err.code === 'UNAUTHORIZED' || err.code === 'FORBIDDEN') {
        halted = err;
      }
      throw err;
    }
  };

  // 1. Keep file names in sync with publish dates ("YYYY-MM-DD-slug.md").
  const taken = new Set(posts.map((p) => p.file));
  for (const post of posts) {
    if (post.data.status === 'published') continue;
    const target = expectedFilename(post, config.timezone);
    if (target === post.file || taken.has(target)) continue;
    renames.push({ post, from: post.file, to: target });
    taken.delete(post.file);
    taken.add(target);
    if (state.posts[post.file]) {
      state.posts[target] = state.posts[post.file];
      delete state.posts[post.file];
    }
    post.file = target;
    log(`rename ${renames.at(-1).from} -> ${target}`);
  }

  // 2. Reconcile each post with Buffer.
  for (const post of posts) {
    if (halted) break;
    const status = post.data.status ?? 'draft';
    if (status === 'published') continue;

    const entries = (state.posts[post.file] ??= {});
    const errors = [];
    const notes = [];
    const when = parsePublishAt(post.data.publish_at, config.timezone);
    const active = ACTIVE_STATUSES.includes(status);
    const desired = active ? postChannels(post) : [];

    if (active) {
      const { errors: invalid } = validatePost(post, config);
      if (invalid.length) {
        errors.push(...invalid);
      } else {
        for (const channel of desired) {
          try {
            await syncChannel(channel);
          } catch (err) {
            errors.push(`${channel}: ${err.message}`);
          }
        }
      }
    }

    async function syncChannel(channel) {
      const entry = entries[channel];
      if (!config.buffer.channels[channel]) {
        throw new Error(`Buffer channel ID is not configured (config/pipeline.yml → buffer.channels.${channel})`);
      }
      const input = composeBufferInput(post, channel, config);
      const hash = hashInput(input);
      if (entry?.hash === hash) return;

      const tooLate = when.getTime() < now.getTime() + MIN_LEAD_MS;
      if (entry && new Date(entry.dueAt).getTime() <= now.getTime()) {
        notes.push(`${channel}: already went out, later edits are not sent to Buffer`);
        return;
      }
      if (tooLate) throw new Error('the publish time has already passed — pick a new time');
      const windowStart = when.getTime() - config.buffer.schedule_window_days * DAY_MS;
      if (!entry && windowStart > now.getTime()) {
        notes.push(`Will be sent to Buffer automatically on ${localDate(new Date(windowStart), config.timezone)}.`);
        return;
      }

      const unreachable = await checkMedia(mediaUrls(post, config));
      if (unreachable.length) {
        throw new Error(`image not reachable yet (${unreachable.join(', ')}); will retry`);
      }

      let result;
      if (entry) {
        try {
          result = await call(() => client.editPost(toEditInput(entry.id, input)));
          actions.push({ type: 'edit', file: post.file, channel, id: entry.id });
        } catch (err) {
          if (err.code !== 'NOT_FOUND') throw err;
          delete entries[channel];
        }
      }
      if (!result) {
        result = await call(() => client.createPost(input));
        actions.push({ type: 'create', file: post.file, channel, id: result.id });
      }
      entries[channel] = { id: result.id, hash, dueAt: input.dueAt, status: result.status ?? 'scheduled' };
      log(`${actions.at(-1).type} ${post.file} [${channel}] -> ${result.id}`);
    }

    // Remove Buffer posts for channels that are no longer wanted (or for
    // posts moved back to draft / canceled).
    for (const [channel, entry] of Object.entries(entries)) {
      if (desired.includes(channel)) continue;
      if (entry.status === 'sent'
        || (!entry.removalPending && new Date(entry.dueAt).getTime() <= now.getTime())) continue;
      try {
        await call(() => client.deletePost(entry.id));
        actions.push({ type: 'delete', file: post.file, channel, id: entry.id });
        log(`delete ${post.file} [${channel}] ${entry.id}`);
      } catch (err) {
        if (err.code !== 'NOT_FOUND') {
          entry.removalPending = true;
          errors.push(`${channel}: could not remove from Buffer: ${err.message}`);
          continue;
        }
      }
      delete entries[channel];
    }

    // 3. Detect posts Buffer has sent (or failed to send).
    let allSent = false;
    if (checkPublished && status === 'scheduled' && desired.length) {
      for (const channel of desired) {
        const entry = entries[channel];
        if (!entry || entry.status === 'sent' || new Date(entry.dueAt).getTime() > now.getTime()) continue;
        try {
          const remote = await call(() => client.getPost(entry.id));
          entry.status = remote.status;
          if (remote.externalLink) entry.externalLink = remote.externalLink;
          if (remote.status === 'error') errors.push(`${channel}: Buffer could not publish: ${remote.error?.message ?? 'unknown error'}`);
        } catch (err) {
          errors.push(`${channel}: could not check publish status: ${err.message}`);
        }
      }
      allSent = desired.every((c) => entries[c]?.status === 'sent');
    }

    if (Object.keys(entries).length === 0) delete state.posts[post.file];

    const fields = { sync_message: [...new Set([...errors, ...notes])].join(' · ') };
    if (active && desired.length) {
      const allQueued = desired.every((c) => entries[c]);
      fields.status = allSent ? 'published' : allQueued ? 'scheduled' : 'approved';
    }
    const before = JSON.stringify([post.data.status, post.data.sync_message ?? '']);
    const after = JSON.stringify([fields.status ?? post.data.status, fields.sync_message]);
    if (before !== after) {
      setFields(post, fields);
      changed.add(post);
    }
  }

  // 4. Posts deleted from the repository: remove their future Buffer posts.
  // Retire state already preserved in the archive without deleting its remote
  // posts. Match IDs, not filenames: a later post can reuse an archived name.
  const files = new Set(posts.map((p) => p.file));
  const archivedIds = new Set(archivedPosts.flatMap((p) => p.archivedBufferIds ?? []));
  for (const [file, entries] of Object.entries(state.posts)) {
    if (files.has(file)) continue;
    for (const [channel, entry] of Object.entries(entries)) {
      if (archivedIds.has(entry.id)) {
        delete entries[channel];
        continue;
      }
      if (entry.status !== 'sent' && (entry.removalPending
        || !Number.isFinite(new Date(entry.dueAt).getTime()) || new Date(entry.dueAt).getTime() > now.getTime())) {
        try {
          await call(() => client.deletePost(entry.id));
          actions.push({ type: 'delete', file, channel, id: entry.id });
          log(`delete ${file} [${channel}] ${entry.id} (post file removed)`);
        } catch (err) {
          if (err.code !== 'NOT_FOUND') {
            entry.removalPending = true;
            log(`warning: could not delete ${entry.id} for removed ${file}: ${err.message}`);
            continue;
          }
        }
      }
      delete entries[channel];
    }
    if (Object.keys(entries).length === 0) delete state.posts[file];
  }

  return { changed, renames, actions, halted };
}
