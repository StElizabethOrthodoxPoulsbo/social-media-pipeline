import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BufferClient } from '../scripts/lib/buffer.mjs';
import { composeIdeaInput, resolveIdeaOrganization, syncIdeas } from '../scripts/lib/ideas.mjs';
import { syncPosts } from '../scripts/lib/sync.mjs';
import { setFields, validatePost } from '../scripts/lib/posts.mjs';
import { qualifiesForArchive } from '../scripts/lib/archive.mjs';
import { normalizeConfig } from '../scripts/lib/config.mjs';
import { config, makePost } from './helpers.mjs';

const NOW = new Date('2026-10-04T12:00:00Z');
const front = {
  title: 'Demo Idea', status: 'draft', publish_at: '2026-10-11T07:00:00-05:00',
  send_to_buffer_ideas: true, channels: [],
};
const emptyChannels = normalizeConfig({ ...config, buffer: { channels: {} } });

function fakeClient() {
  return {
    calls: [],
    async organizations() { this.calls.push(['organizations']); return [{ id: 'org-1' }]; },
    async createIdea(input) { this.calls.push(['createIdea', input]); return { id: 'idea-1' }; },
  };
}

const run = (posts, state, client, extra = {}) => syncIdeas({
  posts, state, config: emptyChannels, client, now: NOW, checkpoint: async () => {}, ...extra,
});

test('Idea input uses supported fields and public assets, excluding private notes and first comments', () => {
  const post = makePost({
    ...front, images: [{ image: '/uploads/icon with space.jpg', alt: 'An icon' }],
    link: 'https://example.org/event', attachments: [{ file: '/uploads/bulletin.pdf', label: 'Bulletin' }],
    notes: 'PRIVATE TEAM NOTES', first_comment: 'PRIVATE COMMENT',
  }, 'Finished caption');
  assert.deepEqual(composeIdeaInput(post, 'org-1', config), {
    organizationId: 'org-1',
    content: {
      title: front.title,
      text: 'Finished caption\n\nhttps://example.org/event\n\nBulletin: https://example.org/smp/uploads/bulletin.pdf',
      date: '2026-10-11T12:00:00.000Z',
      media: [{ url: 'https://example.org/smp/uploads/icon%20with%20space.jpg', type: 'image', alt: 'An icon' }],
    },
  });
  const textOnly = composeIdeaInput(makePost(front), 'org-1', config);
  assert.deepEqual(textOnly.content.media, []);
  assert.equal(JSON.stringify(textOnly).includes('channelId'), false);
  const remote = composeIdeaInput(makePost({ ...front, images: ['https://example.org/icon.jpg'] }), 'org-1', config);
  assert.equal(remote.content.media[0].url, 'https://example.org/icon.jpg');
});

test('organization resolution selects only a sole org or an explicitly accessible configured org', async () => {
  const client = { organizations: async () => [{ id: 'one' }, { id: 'two' }] };
  await assert.rejects(resolveIdeaOrganization(client, config), /2 accessible organizations/);
  assert.equal(await resolveIdeaOrganization(client, { ...config, buffer: { organization_id: 'two' } }), 'two');
  await assert.rejects(resolveIdeaOrganization(client, { ...config, buffer: { organization_id: 'missing' } }), /not accessible/);
  client.organizations = async () => [];
  await assert.rejects(resolveIdeaOrganization(client, config), /0 accessible organizations/);
  client.organizations = async () => [{ id: 'sole' }];
  assert.equal(await resolveIdeaOrganization(client, config), 'sole');
});

test('only an explicit boolean opt-in exports; drafts need no social channel and social status stays unchanged', async () => {
  const post = makePost(front);
  const client = fakeClient();
  const state = {};
  const snapshots = [];
  const result = await run([post], state, client, {
    checkpoint: async () => snapshots.push(structuredClone(state)),
  });
  assert.equal(result.actions.length, 1);
  assert.deepEqual(client.calls.map(([name]) => name), ['organizations', 'createIdea']);
  assert.equal(post.data.status, 'draft');
  assert.equal(post.data.buffer_idea_id, 'idea-1');
  const key = post.data.buffer_idea_key;
  assert.equal(snapshots[0].ideas[key].status, 'pending');
  assert.equal(snapshots[0].ideas[key].id, undefined);
  assert.equal(snapshots[1].ideas[key].status, 'exported');
  assert.equal(snapshots[1].ideas[key].id, 'idea-1');
  assert.match(post.data.buffer_idea_message, /Not scheduled or published/);
  await syncPosts({ posts: [post], state, client, config: emptyChannels, now: NOW });
  assert.equal(post.data.status, 'draft');
  assert.deepEqual(state.posts, {});

  for (const optIn of [undefined, false, 'true']) {
    const client = fakeClient();
    await run([makePost({ ...front, send_to_buffer_ideas: optIn })], {}, client);
    assert.deepEqual(client.calls, []);
  }
  assert.match(validatePost(makePost({ ...front, send_to_buffer_ideas: 'true' }), config).errors.join(), /must be true or false/);
});

test('unchanged, edited, renamed, disabled and canceled exports never recreate, edit or delete remote Ideas', async () => {
  const post = makePost(front);
  const state = {};
  const client = fakeClient();
  await run([post], state, client);
  client.calls = [];
  await run([post], state, client);
  assert.deepEqual(client.calls, []);
  post.body = 'Edited caption';
  post.file = '2026-10-12-demo-renamed.md';
  await run([post], state, client);
  assert.match(post.data.buffer_idea_message, /update the existing Idea manually/);
  for (const status of ['draft', 'canceled', 'published']) {
    setFields(post, { status, send_to_buffer_ideas: false });
    await run([post], state, client);
    assert.match(post.data.buffer_idea_message, /delete it manually/);
  }
  assert.deepEqual(client.calls, []);
  assert.equal(Object.keys(state.ideas).length, 1);
  await run([], state, client);
  assert.equal(Object.keys(state.ideas).length, 1, 'deleted post retains tombstone');
});

test('normal scheduling still happens for separately approved content with Ideas opt-in', async () => {
  const post = makePost({ ...front, status: 'approved', channels: ['facebook'] });
  const state = {};
  const client = fakeClient();
  client.createPost = async (input) => {
    client.calls.push(['createPost', input]);
    return { id: 'social-1', status: 'scheduled' };
  };
  await run([post], state, client, { config });
  assert.equal(post.data.status, 'approved');
  await syncPosts({ posts: [post], state, client, config, now: NOW });
  assert.equal(post.data.status, 'scheduled');
  assert.equal(state.posts[post.file].facebook.id, 'social-1');
  assert.equal(state.ideas[post.data.buffer_idea_key].id, 'idea-1');
});

test('a stale CMS save without generated key/ID recovers filename evidence instead of creating a duplicate', async () => {
  const original = makePost(front);
  const state = {};
  const client = fakeClient();
  await run([original], state, client);
  const stale = makePost(front, 'Saved from an old form');
  client.calls = [];
  await run([stale], state, client);
  assert.deepEqual(client.calls, []);
  assert.equal(stale.data.buffer_idea_key, original.data.buffer_idea_key);
  assert.equal(stale.data.buffer_idea_id, original.data.buffer_idea_id);
  assert.match(stale.data.buffer_idea_message, /update the existing Idea manually/);
  setFields(stale, { publish_at: '2026-10-12T07:00:00-05:00' });
  await syncPosts({ posts: [stale], state, config, client, now: NOW });
  assert.equal(state.ideas[stale.data.buffer_idea_key].file, stale.file);
  const renamedStale = makePost({ ...front, publish_at: stale.data.publish_at }, 'Another old form', stale.file);
  await run([renamedStale], state, client);
  assert.deepEqual(client.calls, []);
  assert.equal(renamedStale.data.buffer_idea_id, original.data.buffer_idea_id);
  const recreatedOldFilename = makePost(front);
  await run([recreatedOldFilename], state, client);
  assert.deepEqual(client.calls, []);
  assert.equal(recreatedOldFilename.data.buffer_idea_id, original.data.buffer_idea_id);
});

test('Ideas validation does not depend on social channels, Instagram limits or an image', async () => {
  const post = makePost({ ...front, status: 'approved', channels: ['instagram'] }, 'x'.repeat(2300));
  const state = {};
  const client = fakeClient();
  await run([post], state, client);
  assert.equal(post.data.buffer_idea_id, 'idea-1');
  assert.equal(post.data.status, 'approved');
  await syncPosts({ posts: [post], state, config: emptyChannels, client, now: NOW });
  assert.match(post.data.sync_message, /Instagram posts need at least one image/);
  assert.equal(post.data.status, 'approved');
});

test('no new export for terminal posts; opted/exported calendar drafts are not expired unused drafts', async () => {
  const client = fakeClient();
  for (const status of ['published', 'canceled']) {
    await run([makePost({ ...front, status })], {}, client);
  }
  assert.deepEqual(client.calls, []);
  const post = makePost({ ...front, source: 'orthocal' });
  const later = new Date('2027-01-01T00:00:00Z');
  assert.equal(qualifiesForArchive(post, config.timezone, later), false);
  setFields(post, { send_to_buffer_ideas: false, buffer_idea_key: 'export-key' });
  assert.equal(qualifiesForArchive(post, config.timezone, later), false);
  setFields(post, { status: 'canceled' });
  assert.equal(qualifiesForArchive(post, config.timezone, later), true);
});

test('validation, organization and unreachable media errors are readable and cause no creation', async () => {
  for (const caption of ['', '<!-- private instructions -->', 'TODO(agent): finish caption']) {
    const post = makePost(front, caption);
    const client = fakeClient();
    const result = await run([post], {}, client);
    assert.equal(result.failures.length, 1);
    assert.equal(post.data.buffer_idea_state, 'error');
    assert.match(post.data.buffer_idea_message, /Ideas export failed/);
    assert.deepEqual(client.calls, []);
  }
  const post = makePost({ ...front, images: ['/uploads/icon.jpg'], attachments: ['/uploads/bulletin.pdf'] });
  const client = fakeClient();
  let checked;
  await run([post], {}, client, { checkMedia: async (urls) => { checked = urls; return [urls[0]]; } });
  assert.deepEqual(checked, ['https://example.org/smp/uploads/icon.jpg', 'https://example.org/smp/uploads/bulletin.pdf']);
  assert.deepEqual(client.calls.map(([name]) => name), ['organizations']);
  assert.match(post.data.buffer_idea_message, /Media not reachable/);
  client.organizations = async () => [{ id: 'one' }, { id: 'two' }];
  await run([post], {}, client);
  assert.match(post.data.buffer_idea_message, /Set buffer.organization_id/);
});

test('checkpoint failure prevents creation; persisted pending/uncertain attempts block replay', async () => {
  const post = makePost(front);
  const client = fakeClient();
  const state = {};
  await assert.rejects(run([post], state, client, {
    checkpoint: async () => { throw new Error('push rejected'); },
  }), /push rejected/);
  assert.deepEqual(client.calls.map(([name]) => name), ['organizations']);
  client.calls = [];
  await run([post], state, client);
  assert.deepEqual(client.calls, []);
  assert.match(post.data.buffer_idea_message, /outcome unknown/i);
  await assert.rejects(run([makePost(front)], {}, client, { checkpoint: undefined }), /durable checkpoint/);
});

test('ambiguous failure and failed result checkpoint cannot create duplicates; key is redacted from result', async () => {
  const post = makePost(front);
  const state = {};
  const client = fakeClient();
  client.apiKey = 'test-secret-not-real';
  client.createIdea = async () => {
    client.calls.push(['createIdea']);
    throw new Error(`HTTP failure ${client.apiKey}`);
  };
  await run([post], state, client);
  assert.equal(state.ideas[post.data.buffer_idea_key].status, 'uncertain');
  assert.equal(post.data.buffer_idea_message.includes(client.apiKey), false);
  client.calls = [];
  await run([post], state, client);
  assert.deepEqual(client.calls, []);

  const second = makePost(front);
  const secondState = {};
  const secondClient = fakeClient();
  let persisted;
  let count = 0;
  await assert.rejects(run([second], secondState, secondClient, {
    checkpoint: async () => {
      if (++count === 2) throw new Error('result push rejected');
      persisted = structuredClone(secondState);
    },
  }), /result push rejected/);
  const resumed = makePost({ ...front, buffer_idea_key: second.data.buffer_idea_key });
  secondClient.calls = [];
  await run([resumed], persisted, secondClient);
  assert.deepEqual(secondClient.calls, []);
  assert.equal(resumed.data.buffer_idea_state, 'uncertain');
});

test('definite rejection retries safely, and an ID without ledger blocks recreation', async () => {
  const post = makePost(front);
  const state = {};
  const client = fakeClient();
  client.createIdea = async () => { throw Object.assign(new Error('invalid input'), { definiteRejection: true }); };
  await run([post], state, client);
  assert.equal(state.ideas[post.data.buffer_idea_key].status, 'error');
  client.createIdea = async () => ({ id: 'fixed-idea' });
  await run([post], state, client);
  assert.equal(post.data.buffer_idea_id, 'fixed-idea');
  client.calls = [];
  const result = await run([post], {}, client);
  assert.deepEqual(client.calls, []);
  assert.equal(result.failures.length, 1);
  assert.match(post.data.buffer_idea_message, /ledger is missing/);
});

test('inconsistent ledger states cannot claim success or create another Idea', async () => {
  for (const entry of [
    { status: 'exported' }, { status: 'unknown' }, { status: 'error', id: 'already-created' },
  ]) {
    const post = makePost({ ...front, buffer_idea_key: 'known-key' });
    const client = fakeClient();
    const state = { ideas: { 'known-key': { ...entry, file: post.file } } };
    const result = await run([post], state, client);
    assert.equal(result.failures.length, 1);
    assert.deepEqual(client.calls, []);
    assert.match(post.data.buffer_idea_message, /ledger is inconsistent/);
  }
});

test('dry run previews without checkpoint, creation, IDs or ledger', async () => {
  const post = makePost(front);
  const client = fakeClient();
  const state = {};
  const result = await run([post], state, client, {
    dryRun: true, checkpoint: async () => { assert.fail('must not checkpoint a preview'); },
  });
  assert.equal(result.actions[0].type, 'preview');
  assert.equal(post.data.buffer_idea_key, undefined);
  assert.deepEqual(state, {});
  assert.deepEqual(client.calls, []);
});

test('Buffer client uses verified Idea/IdeaResponse union shapes and mutation errors; never retries creation', async () => {
  for (const createIdea of [
    { __typename: 'Idea', id: 'direct-id' },
    { __typename: 'IdeaResponse', idea: { id: 'wrapped-id' } },
  ]) {
    let request;
    const client = new BufferClient({
      apiKey: 'not-a-real-key',
      fetchImpl: async (_url, options) => {
        request = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ data: { createIdea } }) };
      },
    });
    const input = composeIdeaInput(makePost(front), 'org-1', config);
    assert.equal((await client.createIdea(input)).id, createIdea.id || createIdea.idea.id);
    assert.match(request.query, /\$input: CreateIdeaInput!/);
    assert.match(request.query, /on IdeaResponse/);
    assert.deepEqual(request.variables, { input });
  }
  let calls = 0;
  const client = new BufferClient({
    apiKey: 'not-a-real-key',
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 503, json: async () => ({ errors: [{ message: 'ambiguous failure' }] }) };
    },
  });
  await assert.rejects(client.createIdea({}), /ambiguous failure/);
  assert.equal(calls, 1);
  for (const type of ['InvalidInputError', 'UnauthorizedError', 'LimitReachedError', 'UnexpectedError', 'IdeaResponse']) {
    client.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { createIdea: { __typename: type, message: 'error details' } } }),
    });
    await assert.rejects(client.createIdea({}), (error) =>
      error.definiteRejection === ['InvalidInputError', 'UnauthorizedError', 'LimitReachedError'].includes(type));
  }
});
