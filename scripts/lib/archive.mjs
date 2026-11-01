import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadPosts, POSTS_DIR } from './posts.mjs';
import { parsePublishAt } from './time.mjs';

export const ARCHIVE_DIR = path.join('archive', 'posts');

export function qualifiesForArchive(post, timeZone, now) {
  if (['published', 'canceled'].includes(post.data.status)) return true;
  // Requested/exported Ideas are not unused calendar drafts. Keep their
  // result visible until the editor explicitly cancels or publishes the post.
  if (post.data.send_to_buffer_ideas === true || post.data.buffer_idea_key) return false;
  const when = parsePublishAt(post.data.publish_at, timeZone);
  return post.data.status === 'draft' && post.data.source === 'orthocal'
    && when !== null && when.getTime() < now.getTime();
}

export async function loadArchivedPosts(root) {
  let directories;
  try {
    directories = await readdir(path.join(root, ARCHIVE_DIR), { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
  const posts = [];
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (directory.isDirectory()) {
      const archived = await loadPosts(root, path.join(ARCHIVE_DIR, directory.name));
      if (!archived.length) continue;
      const evidence = JSON.parse(await readFile(path.join(root, ARCHIVE_DIR, directory.name, 'buffer.json'), 'utf8'));
      const ids = [...Object.values(evidence.before), ...Object.values(evidence.remaining)].map((entry) => entry.id);
      for (const post of archived) post.archivedBufferIds = ids;
      posts.push(...archived);
    }
  }
  return posts;
}

async function preserve(file, content) {
  try {
    await writeFile(file, content, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (await readFile(file, 'utf8') !== content) {
      throw new Error(`Archive collision: refusing to overwrite ${file}`);
    }
  }
}

/** Preserve original Markdown bytes and Buffer evidence before removing an active file. */
export async function archivePosts({
  root, posts, state, previousState = state, timeZone, now = new Date(), dryRun = false, log = () => {},
}) {
  const archived = [];
  const blocked = [];
  for (const post of posts) {
    if (!qualifiesForArchive(post, timeZone, now)) continue;
    const entries = state.posts?.[post.file] ?? {};
    // An unknown due time is not proof that a queued post is safe to forget.
    const pending = post.data.status !== 'published' && Object.values(entries).some((entry) =>
      entry.status !== 'sent'
      && (entry.removalPending || !Number.isFinite(new Date(entry.dueAt).getTime())
        || new Date(entry.dueAt).getTime() > now.getTime()));
    if (pending) {
      blocked.push(post.file);
      log(`defer archive ${post.file}: Buffer removal is still pending`);
      continue;
    }
    const source = path.join(root, POSTS_DIR, post.file);
    const text = await readFile(source, 'utf8');
    const evidence = `${JSON.stringify({
      file: post.file,
      before: previousState.posts?.[post.file] ?? {},
      remaining: entries,
      ...(post.data.buffer_idea_key ? {
        idea: state.ideas?.[post.data.buffer_idea_key] ?? previousState.ideas?.[post.data.buffer_idea_key] ?? null,
      } : {}),
    }, null, 2)}\n`;
    const digest = createHash('sha256').update(text).update(evidence).digest('hex');
    const directory = path.join(root, ARCHIVE_DIR, digest);
    if (!dryRun) {
      await mkdir(directory, { recursive: true });
      await preserve(path.join(directory, 'buffer.json'), evidence);
      await preserve(path.join(directory, post.file), text);
      await unlink(source);
      if (state.posts) delete state.posts[post.file];
    }
    archived.push(post.file);
    log(`${dryRun ? '[dry-run] ' : ''}archive ${post.file}`);
  }
  return { archived, blocked };
}
