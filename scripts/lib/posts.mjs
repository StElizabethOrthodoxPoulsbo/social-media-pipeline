import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { SUPPORTED_CHANNELS } from './config.mjs';
import { localDate, parsePublishAt } from './time.mjs';

export const POSTS_DIR = path.join('content', 'posts');

export const STATUSES = ['draft', 'in-review', 'approved', 'scheduled', 'published', 'canceled'];
/** Statuses whose posts should exist in Buffer. */
export const ACTIVE_STATUSES = ['approved', 'scheduled'];

export const FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const PLACEHOLDER_PATTERN = /TODO\(agent\)/;

export const LIMITS = {
  instagram: { text: 2200, hashtags: 30, images: 10 },
  facebook: { text: 63206, images: 10 },
};

export function parsePost(text, file = 'post.md') {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n(?:([\s\S]*?)\n)?---(?:\n([\s\S]*))?$/);
  if (!match) throw new Error(`${file}: missing YAML front matter`);
  const doc = YAML.parseDocument(match[1] ?? '');
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
  const data = doc.toJS() ?? {};
  const body = (match[2] ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
  return { file, doc, data, body };
}

export function serializePost(post) {
  const front = post.doc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n\n${post.body.trim()}\n`;
}

/** Set (or, for undefined/empty values, remove) front matter fields. */
export function setFields(post, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') post.doc.delete(key);
    else post.doc.set(key, value);
  }
  post.data = post.doc.toJS() ?? {};
}

export async function loadPosts(root, directory = POSTS_DIR) {
  const dir = path.join(root, directory);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const posts = [];
  for (const name of names) {
    const text = await readFile(path.join(dir, name), 'utf8');
    posts.push(parsePost(text, name));
  }
  return posts;
}

export async function writePost(root, post) {
  await writeFile(path.join(root, POSTS_DIR, post.file), serializePost(post));
}

export async function renamePost(root, post, newFile) {
  await rename(path.join(root, POSTS_DIR, post.file), path.join(root, POSTS_DIR, newFile));
  post.file = newFile;
}

export function slugify(text, maxLength = 60) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug || 'post';
  const cut = slug.slice(0, maxLength);
  return cut.slice(0, cut.lastIndexOf('-') > 20 ? cut.lastIndexOf('-') : maxLength).replace(/-+$/, '');
}

export function asList(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

/** Channels requested by the post, lower-cased. */
export function postChannels(post) {
  return asList(post.data.channels).map((c) => String(c).toLowerCase());
}

export function postImages(post) {
  return asList(post.data.images)
    .map((img) => (typeof img === 'string' ? { image: img } : img ?? {}))
    .filter((img) => img.image);
}

export function postAttachments(post) {
  return asList(post.data.attachments)
    .map((a) => (typeof a === 'string' ? { file: a } : a ?? {}))
    .filter((a) => a.file);
}

/** The filename a post should have: "<local publish date>-<slug>.md". */
export function expectedFilename(post, timeZone) {
  const when = parsePublishAt(post.data.publish_at, timeZone);
  if (!when) return post.file;
  const match = post.file.match(FILENAME_PATTERN);
  const slug = match ? match[2] : slugify(post.data.title ?? post.file.replace(/\.md$/, ''));
  return `${localDate(when, timeZone)}-${slug}.md`;
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isMediaPath(value) {
  return typeof value === 'string' && (value.startsWith('/') || isUrl(value));
}

/**
 * Validate a post. Errors block scheduling (and fail CI); warnings are
 * informational. Requirements that only matter for publishing (caption,
 * Instagram image) are errors only once a post is approved.
 */
export function validatePost(post, config, { forbidPlaceholders = false } = {}) {
  const errors = [];
  const warnings = [];
  const { data } = post;
  const status = data.status ?? 'draft';
  const publishing = ACTIVE_STATUSES.includes(status);
  const needsWork = (msg) => (publishing ? errors : warnings).push(msg);

  if (!FILENAME_PATTERN.test(post.file)) {
    errors.push(`file name must look like "2026-10-05-st-nicholas.md"`);
  }
  if (!data.title || typeof data.title !== 'string') errors.push('title is required');
  if (!STATUSES.includes(status)) {
    errors.push(`status "${status}" must be one of: ${STATUSES.join(', ')}`);
  }

  const when = parsePublishAt(data.publish_at, config.timezone);
  if (!when) {
    errors.push('publish_at must be a date and time, e.g. 2026-10-05T09:00:00-05:00');
  } else if (FILENAME_PATTERN.test(post.file)) {
    const expected = expectedFilename(post, config.timezone);
    if (expected !== post.file) {
      warnings.push(`file will be renamed to ${expected} to match its publish date`);
    }
  }

  const channels = postChannels(post);
  for (const c of channels) {
    if (!SUPPORTED_CHANNELS.includes(c)) errors.push(`unsupported channel "${c}"`);
  }
  if (channels.length === 0) needsWork('choose at least one channel');

  const text = post.body.trim();
  if (!text) needsWork('caption is empty');
  if (/<!--/.test(text)) needsWork('caption contains an HTML comment');
  if (PLACEHOLDER_PATTERN.test(text) || PLACEHOLDER_PATTERN.test(String(data.title ?? ''))) {
    (forbidPlaceholders ? errors : warnings).push('caption still contains a TODO(agent) placeholder');
  }

  const images = postImages(post);
  for (const img of images) {
    if (!isMediaPath(img.image)) errors.push(`image "${img.image}" must be an uploaded file or https URL`);
  }
  for (const a of postAttachments(post)) {
    if (!isMediaPath(a.file)) errors.push(`attachment "${a.file}" must be an uploaded file or https URL`);
  }
  if (data.link && !isUrl(data.link)) errors.push(`link "${data.link}" is not a valid URL`);

  if (channels.includes('instagram')) {
    if (images.length === 0) needsWork('Instagram posts need at least one image');
    if (images.length > LIMITS.instagram.images) errors.push('Instagram allows at most 10 images');
    if (text.length > LIMITS.instagram.text) errors.push(`caption is over Instagram's ${LIMITS.instagram.text} characters`);
    const hashtags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    if (hashtags.length > LIMITS.instagram.hashtags) errors.push('Instagram allows at most 30 hashtags');
  }
  if (channels.includes('facebook') && text.length > LIMITS.facebook.text) {
    errors.push('caption is too long for Facebook');
  }

  return { errors, warnings };
}
