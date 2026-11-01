#!/usr/bin/env node
// Sync approved posts to Buffer: create, edit or delete Buffer posts so they
// match the Markdown files in content/posts, then record the result.
//
// Usage: node scripts/sync-buffer.mjs [--dry-run] [--check-published]
//   BUFFER_API_KEY  Buffer personal API key (without it, only local archival is saved)

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BufferClient } from './lib/buffer.mjs';
import { archivePosts, loadArchivedPosts } from './lib/archive.mjs';
import { loadConfig, ROOT } from './lib/config.mjs';
import { loadPosts, POSTS_DIR, writePost } from './lib/posts.mjs';
import { syncPosts } from './lib/sync.mjs';

const STATE_FILE = path.join(ROOT, 'state', 'buffer.json');

class DryRunClient {
  count = 0;
  requests = 0;
  fake(input) {
    return { id: `dry-run-${++this.count}`, status: 'scheduled', dueAt: input.dueAt };
  }
  async createPost(input) { return this.fake(input); }
  async editPost(input) { return this.fake(input); }
  async deletePost(id) { return { id }; }
  async getPost(id) { return { id, status: 'scheduled' }; }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { posts: {} };
    throw err;
  }
}

function sortKeys(value) {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

async function checkMedia(urls) {
  const unreachable = [];
  for (const url of urls) {
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 15_000));
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
        ok = res.ok;
      } catch {
        ok = false;
      }
    }
    if (!ok) unreachable.push(url);
  }
  return unreachable;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apiKey = process.env.BUFFER_API_KEY;
  const dryRun = args.has('--dry-run') || !apiKey;
  if (!apiKey && !args.has('--dry-run')) {
    console.warn('BUFFER_API_KEY is not set — previewing Buffer changes only; safe local archival still runs.');
  }

  const config = await loadConfig();
  const posts = await loadPosts(ROOT);
  const state = await readState();
  const previousState = structuredClone(state);
  const archivedPosts = await loadArchivedPosts(ROOT);
  const now = new Date();
  const client = dryRun ? new DryRunClient() : new BufferClient({ apiKey });

  const result = await syncPosts({
    posts,
    archivedPosts,
    state,
    config,
    client,
    now,
    checkPublished: args.has('--check-published'),
    checkMedia: dryRun ? async () => [] : checkMedia,
    log: (msg) => console.log(`${dryRun ? '[dry-run] ' : ''}${msg}`),
  });

  if (!dryRun) {
    for (const { from, to } of result.renames) {
      await rename(path.join(ROOT, POSTS_DIR, from), path.join(ROOT, POSTS_DIR, to));
      if (previousState.posts?.[from]) {
        previousState.posts[to] = previousState.posts[from];
        delete previousState.posts[from];
      }
    }
    for (const post of result.changed) await writePost(ROOT, post);
  }

  // Never use simulated Buffer deletions as evidence that archival is safe.
  const archiveState = dryRun ? previousState : state;
  if (!args.has('--dry-run')) {
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(sortKeys(archiveState), null, 2)}\n`);
  }
  const archiveResult = await archivePosts({
    root: ROOT,
    posts: dryRun ? await loadPosts(ROOT) : posts,
    state: archiveState,
    previousState,
    timeZone: config.timezone,
    now,
    dryRun: args.has('--dry-run'),
    log: console.log,
  });
  if (!args.has('--dry-run')) {
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(sortKeys(archiveState), null, 2)}\n`);
  }

  const lines = [
    `## Buffer sync${dryRun ? ' (dry run)' : ''}`,
    '',
    `- Created: ${result.actions.filter((a) => a.type === 'create').length}`,
    `- Updated: ${result.actions.filter((a) => a.type === 'edit').length}`,
    `- Removed: ${result.actions.filter((a) => a.type === 'delete').length}`,
    `- Renamed files: ${result.renames.length}`,
    `- API requests: ${client.requests}`,
    `- Archived${args.has('--dry-run') ? ' (preview)' : ''}: ${archiveResult.archived.length}`,
    `- Awaiting Buffer removal: ${archiveResult.blocked.length}`,
  ];
  const messages = posts.filter((p) => p.data.sync_message);
  if (messages.length) {
    lines.push('', '### Messages', '');
    for (const p of messages) lines.push(`- \`${p.file}\`: ${p.data.sync_message}`);
  }
  if (result.halted) lines.push('', `**Stopped early:** ${result.halted.message}`);
  const summary = `${lines.join('\n')}\n`;
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);

  if (result.halted) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
