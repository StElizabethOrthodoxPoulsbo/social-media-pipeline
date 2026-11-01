import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { archivePosts, ARCHIVE_DIR, loadArchivedPosts, qualifiesForArchive } from '../scripts/lib/archive.mjs';
import { loadCoveredCalendarDates } from '../scripts/hydrate-calendar.mjs';
import { loadPosts, POSTS_DIR, serializePost } from '../scripts/lib/posts.mjs';
import { syncPosts } from '../scripts/lib/sync.mjs';
import { ROOT } from '../scripts/lib/config.mjs';
import { config, makePost } from './helpers.mjs';

const now = new Date('2026-10-11T12:00:00Z');
const front = { title: 'St Thomas', status: 'draft', source: 'orthocal', orthocal_date: '2026-10-11', publish_at: '2026-10-11T07:00:00-05:00' };
const entry = { id: 'buffer-1', dueAt: '2026-10-12T12:00:00Z', status: 'scheduled', hash: 'caption-hash' };

async function fixture(t, post = makePost(front), text = serializePost(post)) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'post-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, POSTS_DIR), { recursive: true });
  await writeFile(path.join(root, POSTS_DIR, post.file), text);
  return root;
}

const archive = (root, posts, state = { posts: {} }, extra = {}) =>
  archivePosts({ root, posts, state, timeZone: config.timezone, now, ...extra });

test('eligibility is immediate for terminal statuses and strictly past for explicit calendar drafts', () => {
  for (const status of ['published', 'canceled']) {
    assert.equal(qualifiesForArchive(makePost({ ...front, status, publish_at: '2027-01-01T00:00:00Z' }), config.timezone, now), true);
  }
  for (const publish_at of ['2026-10-11T06:59:59-05:00', '2026-10-11T06:59:59', '2026-10-01T12:00:00Z']) {
    assert.equal(qualifiesForArchive(makePost({ ...front, publish_at }), config.timezone, now), true);
  }
  for (const publish_at of [front.publish_at, '2026-10-11T07:00:01-05:00', 'invalid', undefined]) {
    assert.equal(qualifiesForArchive(makePost({ ...front, publish_at }), config.timezone, now), false);
  }
  for (const status of ['in-review', 'approved', 'scheduled', undefined]) {
    assert.equal(qualifiesForArchive(makePost({ ...front, status, publish_at: '2020-01-01T00:00:00Z' }), config.timezone, now), false);
  }
  for (const source of ['manual', undefined]) {
    assert.equal(qualifiesForArchive(makePost({ ...front, source, publish_at: '2020-01-01T00:00:00Z' }), config.timezone, now), false);
  }
});

test('archive preserves exact Markdown, media references, sent evidence, and covered calendar dates; reruns are no-ops', async (t) => {
  const post = makePost({ ...front, status: 'published', images: ['/uploads/icon.jpg'] });
  const text = serializePost(post).replace(/\n/g, '\r\n');
  const root = await fixture(t, post, text);
  const sent = { ...entry, status: 'sent', externalLink: 'https://facebook.com/p/1' };
  const state = { posts: { [post.file]: { facebook: sent } } };
  assert.deepEqual((await archive(root, [post], state)).archived, [post.file]);
  assert.deepEqual(await loadPosts(root), []);
  assert.deepEqual(state.posts, {});
  const [directory] = await readdir(path.join(root, ARCHIVE_DIR));
  assert.equal(await readFile(path.join(root, ARCHIVE_DIR, directory, post.file), 'utf8'), text);
  const evidence = JSON.parse(await readFile(path.join(root, ARCHIVE_DIR, directory, 'buffer.json'), 'utf8'));
  assert.deepEqual(evidence.remaining.facebook, sent);
  assert.equal((await loadArchivedPosts(root))[0].file, post.file);
  assert.equal((await loadCoveredCalendarDates(root)).has(front.orthocal_date), true);
  assert.deepEqual((await archive(root, await loadPosts(root), state)).archived, []);
  assert.equal((await readdir(path.join(root, ARCHIVE_DIR))).length, 1);
});

test('same filename with different content is never overwritten and dry runs preserve source and state', async (t) => {
  const post = makePost({ ...front, status: 'published' });
  const root = await fixture(t, post);
  const state = { posts: { [post.file]: { facebook: entry } } };
  const originalState = structuredClone(state);
  await archive(root, [post], state, { dryRun: true });
  assert.deepEqual(state, originalState);
  assert.equal((await loadPosts(root)).length, 1);
  await archive(root, [post], state);
  const second = makePost({ ...front, status: 'published' }, 'A different caption');
  await writeFile(path.join(root, POSTS_DIR, second.file), serializePost(second));
  await archive(root, [second]);
  assert.equal((await loadArchivedPosts(root)).length, 2);
});

test('archival preserves separate Idea evidence and retains its tombstone without remote calls', async (t) => {
  const post = makePost({
    ...front, status: 'canceled', send_to_buffer_ideas: true,
    buffer_idea_key: 'idea-key', buffer_idea_id: 'idea-1', buffer_idea_state: 'exported',
  });
  const root = await fixture(t, post);
  const idea = { id: 'idea-1', status: 'exported', organizationId: 'org-1', hash: 'idea-hash' };
  const state = { posts: {}, ideas: { 'idea-key': idea } };
  await syncPosts({ posts: [post], state, config, client: {}, now });
  assert.deepEqual((await archive(root, [post], state)).archived, [post.file]);
  const [directory] = await readdir(path.join(root, ARCHIVE_DIR));
  const evidence = JSON.parse(await readFile(path.join(root, ARCHIVE_DIR, directory, 'buffer.json'), 'utf8'));
  assert.deepEqual(evidence.idea, idea);
  assert.deepEqual(state.ideas, { 'idea-key': idea });
  const [archived] = await loadArchivedPosts(root);
  assert.equal(archived.data.buffer_idea_id, 'idea-1');
  assert.deepEqual(archived.archivedBufferIds, []);
});

test('existing conflicting archive content fails explicitly without removing the active source', async (t) => {
  const post = makePost({ ...front, status: 'published' });
  const text = serializePost(post);
  const root = await fixture(t, post);
  const evidence = `${JSON.stringify({ file: post.file, before: {}, remaining: {} }, null, 2)}\n`;
  const digest = createHash('sha256').update(text).update(evidence).digest('hex');
  const directory = path.join(root, ARCHIVE_DIR, digest);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, post.file), 'Different history');
  await assert.rejects(archive(root, [post]), /Archive collision/);
  assert.equal(await readFile(path.join(root, POSTS_DIR, post.file), 'utf8'), text);
});

test('failed cancellation retains future retry state; success and NOT_FOUND permit archival with deletion evidence', async (t) => {
  for (const failure of ['temporary failure', 'NOT_FOUND', null]) {
    const post = makePost({ ...front, status: 'canceled' });
    const root = await fixture(t, post);
    const state = { posts: { [post.file]: { facebook: { ...entry } } } };
    const previousState = structuredClone(state);
    const client = { deletePost: async () => {
      if (failure) throw Object.assign(new Error(failure), { code: failure });
    } };
    await syncPosts({ posts: [post], state, client, config, now });
    const result = await archive(root, [post], state, { previousState });
    if (failure === 'temporary failure') {
      assert.deepEqual(result.blocked, [post.file]);
      assert.equal(state.posts[post.file].facebook.id, entry.id);
      assert.match(post.data.sync_message, /could not remove/);
    } else {
      assert.deepEqual(result.archived, [post.file]);
      const [directory] = await readdir(path.join(root, ARCHIVE_DIR));
      const evidence = JSON.parse(await readFile(path.join(root, ARCHIVE_DIR, directory, 'buffer.json'), 'utf8'));
      assert.equal(evidence.before.facebook.id, entry.id);
      assert.deepEqual(evidence.remaining, {});
    }
  }
});

test('pending unknown-time entries block cleanup; sent and past entries preserve evidence without deleting remotely', async (t) => {
  for (const remote of [{ ...entry, dueAt: 'invalid' }, { ...entry, status: 'sent' }, { ...entry, dueAt: now.toISOString() }]) {
    const post = makePost({ ...front, status: 'canceled' });
    const root = await fixture(t, post);
    const state = { posts: { [post.file]: { facebook: remote } } };
    const result = await archive(root, [post], state);
    assert.equal(result.archived.length, remote.dueAt === 'invalid' ? 0 : 1);
  }
});

test('failed deletions remain retryable and block archival even after their due time passes', async (t) => {
  const post = makePost({ ...front, status: 'canceled' });
  const root = await fixture(t, post);
  const state = { posts: { [post.file]: { facebook: { ...entry } } } };
  const client = { deletePost: async () => { throw new Error('temporary failure'); } };
  await syncPosts({ posts: [post], state, config, client, now });
  assert.equal(state.posts[post.file].facebook.removalPending, true);
  const later = new Date('2026-10-13T12:00:00Z');
  assert.deepEqual((await archive(root, [post], state, { now: later })).blocked, [post.file]);
  let removed;
  client.deletePost = async (id) => { removed = id; };
  await syncPosts({ posts: [post], state, config, client, now: later });
  assert.equal(removed, entry.id);
  assert.deepEqual((await archive(root, [post], state, { now: later })).archived, [post.file]);
});

test('rate limiting cannot prevent unrelated safe archives; archived state is not mistaken for deleted content', async (t) => {
  const canceled = makePost({ ...front, status: 'canceled' });
  const published = makePost({ ...front, status: 'published' }, 'Sent', '2026-10-11-other.md');
  const root = await fixture(t, canceled);
  await writeFile(path.join(root, POSTS_DIR, published.file), serializePost(published));
  const state = { posts: { [canceled.file]: { facebook: entry }, [published.file]: { facebook: entry } } };
  const client = { deletePost: async () => { throw Object.assign(new Error('slow down'), { code: 'RATE_LIMIT_EXCEEDED' }); } };
  const result = await syncPosts({ posts: [canceled, published], state, config, client, now });
  assert.equal(result.halted.code, 'RATE_LIMIT_EXCEEDED');
  assert.deepEqual((await archive(root, [canceled, published], state)).archived, [published.file]);
  const interruptedState = { posts: { [published.file]: { facebook: entry } } };
  await syncPosts({ posts: [], archivedPosts: await loadArchivedPosts(root), state: interruptedState, config, client, now });
  assert.deepEqual(interruptedState.posts, {});
  let deleted;
  client.deletePost = async (id) => { deleted = id; };
  const reusedState = { posts: { [published.file]: { facebook: { ...entry, id: 'new-buffer-id' } } } };
  await syncPosts({ posts: [], archivedPosts: await loadArchivedPosts(root), state: reusedState, config, client, now });
  assert.equal(deleted, 'new-buffer-id');
  assert.deepEqual(reusedState.posts, {});
});

test('CLI without credentials archives safe posts but never saves simulated cancellations; explicit dry run saves nothing', async (t) => {
  for (const dryRun of [false, true]) {
    const post = makePost({ ...front, status: 'published' });
    const root = await fixture(t, post);
    const canceled = makePost({ ...front, status: 'canceled', publish_at: '2099-10-11T07:00:00-05:00' }, 'Stop', '2099-10-11-canceled.md');
    await writeFile(path.join(root, POSTS_DIR, canceled.file), serializePost(canceled));
    await cp(path.join(ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    await cp(path.join(ROOT, 'config'), path.join(root, 'config'), { recursive: true });
    await symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    await mkdir(path.join(root, 'state'));
    const state = { posts: { [canceled.file]: { facebook: { ...entry, dueAt: '2099-10-11T12:00:00Z' } } } };
    const text = `${JSON.stringify(state)}\n`;
    await writeFile(path.join(root, 'state', 'buffer.json'), text);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-buffer.mjs'), ...(dryRun ? ['--dry-run'] : [])], {
      env: { ...process.env, BUFFER_API_KEY: '', GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await loadPosts(root)).length, dryRun ? 2 : 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'state', 'buffer.json'), 'utf8')), state);
    if (dryRun) assert.equal(await readFile(path.join(root, 'state', 'buffer.json'), 'utf8'), text);
  }
});

test('publish workflow runs and persists cleanup independently of deployment and Buffer failure', async () => {
  const workflow = YAML.parse(await readFile(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8'));
  const job = workflow.jobs['sync-buffer'];
  assert.equal(job.if, '${{ always() }}');
  assert.ok(workflow.on.schedule.length);
  assert.ok(workflow.on.push.paths.includes('content/**'));
  const sync = job.steps.find((step) => step.name === 'Sync with Buffer');
  assert.match(sync.run, /scripts\/sync-buffer.mjs/);
  const commit = job.steps.find((step) => step.name === 'Commit status updates');
  assert.equal(commit.if, '${{ always() && !inputs.dry_run }}');
  assert.match(commit.run, /git add -A content\/posts archive state/);
  const cms = YAML.parse(await readFile(path.join(ROOT, 'site/admin/config.yml'), 'utf8'));
  assert.equal(cms.collections.find((collection) => collection.name === 'posts').folder, '/content/posts');
});
