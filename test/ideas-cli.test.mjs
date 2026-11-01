import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { ROOT } from '../scripts/lib/config.mjs';
import { loadPosts, serializePost } from '../scripts/lib/posts.mjs';
import { makePost } from './helpers.mjs';

async function fixture(t, { rejectedPush = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ideas-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout');
  const remote = path.join(root, 'remote.git');
  await mkdir(path.join(repo, 'content/posts'), { recursive: true });
  await mkdir(path.join(repo, 'config'));
  await mkdir(path.join(repo, 'state'));
  await cp(path.join(ROOT, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  await symlink(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(repo, 'config/pipeline.yml'), YAML.stringify({
    timezone: 'America/Chicago',
    site_url: 'https://example.org/demo',
    buffer: { channels: {} },
  }));
  const post = makePost({
    title: 'Authorized fixture only', status: 'draft', publish_at: '2099-10-11T07:00:00-05:00',
    send_to_buffer_ideas: true, channels: [], images: ['/uploads/icon.jpg'],
  }, 'Demo fixture caption', '2099-10-11-fixture.md');
  await writeFile(path.join(repo, 'content/posts', post.file), serializePost(post));
  await writeFile(path.join(repo, 'state/buffer.json'), '{"posts":{}}\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('init', '--bare', '--initial-branch=main', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '--set-upstream', 'origin', 'main');
  if (rejectedPush) {
    await writeFile(path.join(repo, '.git/hooks/pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  return { repo, remote, git };
}

function run(repo, remote, { ambiguous = false, dryRun = false } = {}) {
  // All Buffer/HEAD requests are intercepted. A local bare repository acts
  // as GitHub; no real API key, remote network or Buffer mutation is used.
  const preload = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, options) => {
      if (options.method === 'HEAD') return { ok: true };
      const { query } = JSON.parse(options.body);
      if (query.includes('organizations')) return {
        ok: true, status: 200, json: async () => ({ data: { account: { organizations: [{ id: 'org-fixture' }] } } })
      };
      assert.match(query, /mutation CreateIdea/);
      const pushed = JSON.parse(execFileSync('git', ['--git-dir', ${JSON.stringify(remote)}, 'show', 'main:state/buffer.json'], { encoding: 'utf8' }));
      assert.equal(Object.values(pushed.ideas)[0].status, 'pending');
      appendFileSync('creation-calls.txt', 'createIdea\\n');
      return ${ambiguous
        ? "{ ok: false, status: 503, json: async () => ({ errors: [{ message: 'fixture ambiguous outcome' }] }) }"
        : "{ ok: true, status: 200, json: async () => ({ data: { createIdea: { __typename: 'Idea', id: 'fixture-idea' } } }) }"};
    };
  `;
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    'scripts/sync-buffer.mjs', '--checkpoint-ideas', ...(dryRun ? ['--dry-run'] : []),
  ], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, BUFFER_API_KEY: 'fake-fixture-key', GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '' },
  });
}

test('main CLI pushes pending before Idea creation, saves returned ID remotely and reruns without duplication', async (t) => {
  const { repo, remote, git } = await fixture(t);
  const result = run(repo, remote);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ideas exported \(not scheduled\): 1/);
  const state = JSON.parse(git('show', 'origin/main:state/buffer.json'));
  assert.equal(Object.values(state.ideas)[0].id, 'fixture-idea');
  assert.equal(Object.values(state.ideas)[0].status, 'exported');
  assert.deepEqual(state.posts, {});
  const [post] = await loadPosts(repo);
  assert.equal(post.data.status, 'draft');
  assert.equal(post.data.buffer_idea_id, 'fixture-idea');
  assert.match(git('show', `origin/main:content/posts/${post.file}`), /buffer_idea_id: fixture-idea/);
  const second = run(repo, remote);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(path.join(repo, 'creation-calls.txt'), 'utf8'), 'createIdea\n');
});

test('CLI ambiguous failure persists a non-replayable outcome and reports workflow failure', async (t) => {
  const { repo, remote, git } = await fixture(t);
  const result = run(repo, remote, { ambiguous: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /automatic retry is blocked/);
  const state = JSON.parse(git('show', 'origin/main:state/buffer.json'));
  assert.equal(Object.values(state.ideas)[0].status, 'uncertain');
  const second = run(repo, remote);
  assert.equal(second.status, 1);
  assert.equal(await readFile(path.join(repo, 'creation-calls.txt'), 'utf8'), 'createIdea\n');
});

test('a rejected pre-creation push prevents the API mutation entirely', async (t) => {
  const { repo, remote, git } = await fixture(t, { rejectedPush: true });
  const result = run(repo, remote);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git push origin HEAD:main/);
  await assert.rejects(readFile(path.join(repo, 'creation-calls.txt')), { code: 'ENOENT' });
  const remoteState = JSON.parse(git('show', 'origin/main:state/buffer.json'));
  assert.equal(remoteState.ideas, undefined);
});

test('CLI explicit dry run persists nothing and never creates an Idea', async (t) => {
  const { repo, remote, git } = await fixture(t);
  const before = git('rev-parse', 'HEAD');
  const stateBefore = await readFile(path.join(repo, 'state/buffer.json'), 'utf8');
  const result = run(repo, remote, { dryRun: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ideas previewed \(not scheduled\): 1/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(await readFile(path.join(repo, 'state/buffer.json'), 'utf8'), stateBefore);
  assert.equal(git('status', '--porcelain'), '');
  await assert.rejects(readFile(path.join(repo, 'creation-calls.txt')), { code: 'ENOENT' });
});

test('CMS, main workflow and public media configuration wire the same opt-in and durable state', async () => {
  const cms = YAML.parse(await readFile(path.join(ROOT, 'site/admin/config.yml'), 'utf8'));
  assert.equal(cms.backend.repo, 'StElizabethOrthodoxPoulsbo/social-media-pipeline');
  assert.equal(cms.backend.branch, 'main');
  const site = 'https://stelizabethorthodoxpoulsbo.github.io/social-media-pipeline';
  assert.equal(cms.site_url, site);
  assert.equal(cms.display_url, site);
  const config = YAML.parse(await readFile(path.join(ROOT, 'config/pipeline.yml'), 'utf8'));
  assert.equal(config.site_url, site);
  const fields = cms.collections[0].fields;
  const optIn = fields.find((field) => field.name === 'send_to_buffer_ideas');
  assert.equal(optIn.widget, 'boolean');
  assert.equal(optIn.default, false);
  for (const name of ['buffer_idea_id', 'buffer_idea_state', 'buffer_idea_message']) {
    assert.equal(fields.find((field) => field.name === name).readonly, true);
  }
  assert.equal(fields.find((field) => field.name === 'buffer_idea_key').widget, 'hidden');
  assert.equal(fields.find((field) => field.name === 'channels').required, false);
  const workflow = YAML.parse(await readFile(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8'));
  const job = workflow.jobs['sync-buffer'];
  assert.match(job.steps.find((step) => step.name === 'Sync with Buffer').run, /--checkpoint-ideas/);
  const author = job.steps.findIndex((step) => step.name === 'Configure checkpoint author');
  const sync = job.steps.findIndex((step) => step.name === 'Sync with Buffer');
  assert.ok(author >= 0 && author < sync);
  assert.equal(job.steps[0].with.ref, 'main');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});
