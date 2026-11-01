#!/usr/bin/env node
// Draft upcoming feast-day and Sunday posts from orthocal.info.
//
// Creates one skeleton Markdown post (status: draft) per upcoming Sunday or
// major feast that does not already have a post, and writes a JSON manifest
// describing each new day. The agentic workflow then writes the captions.
//
// Usage: node scripts/hydrate-calendar.mjs [--today YYYY-MM-DD] [--manifest file] [--dry-run]

import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { loadConfig, ROOT } from './lib/config.mjs';
import { loadArchivedPosts } from './lib/archive.mjs';
import { dateRange, dayTitle, daySlugSource, describeDay, fetchRange, selectCandidates } from './lib/orthocal.mjs';
import { loadPosts, POSTS_DIR, slugify } from './lib/posts.mjs';
import { localDate, zonedIso } from './lib/time.mjs';

export const PLACEHOLDER = 'TODO(agent): write the caption for this post.';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--today') args.today = argv[++i];
    else if (argv[i] === '--manifest') args.manifest = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export function skeletonPost(day, info, config) {
  const front = {
    title: dayTitle(day),
    status: 'draft',
    publish_at: zonedIso(day.date, config.calendar.default_post_time, config.timezone),
    channels: config.calendar.default_channels,
    source: 'orthocal',
    orthocal_date: day.date,
    notes: [
      `${info.weekday}, ${info.date} — ${info.feast_rank}`,
      info.feasts.length ? `Feasts: ${info.feasts.join('; ')}` : null,
      info.saints.length ? `Saints: ${info.saints.join('; ')}` : null,
      info.readings.length ? `Readings: ${info.readings.join('; ')}` : null,
      info.fast ? `Fasting: ${info.fast}` : null,
      `Calendar: ${info.orthocal_url}`,
      config.calendar.default_channels.includes('instagram')
        ? 'Add an icon image before approving — Instagram posts need one.'
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  };
  return `---\n${YAML.stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n\n${PLACEHOLDER}\n`;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function loadCoveredCalendarDates(root) {
  const posts = [...await loadPosts(root), ...await loadArchivedPosts(root)];
  return new Set(posts.map((p) => p.data.orthocal_date).filter(Boolean).map(String));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const today = args.today ?? localDate(new Date(), config.timezone);
  const { start, end } = dateRange(today, config.calendar.lookahead_days);

  const covered = await loadCoveredCalendarDates(ROOT);

  console.log(`Fetching ${config.calendar.source} calendar ${start} … ${end} from orthocal.info`);
  const days = await fetchRange(config.calendar.source, start, end);
  const candidates = selectCandidates(days, config.calendar);

  const items = [];
  for (const day of candidates) {
    if (covered.has(day.date)) continue;
    const file = `${day.date}-${slugify(daySlugSource(day))}.md`;
    const fullPath = path.join(ROOT, POSTS_DIR, file);
    if (await exists(fullPath)) {
      console.log(`skip ${file}: a post with this name already exists`);
      continue;
    }
    const info = describeDay(day, config.calendar.source);
    if (!args.dryRun) {
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, skeletonPost(day, info, config));
    }
    items.push({ file: path.posix.join('content', 'posts', file), ...info });
    console.log(`${args.dryRun ? '[dry-run] ' : ''}draft ${file} — ${info.title}`);
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    parish: config.parish,
    calendar: config.calendar.source,
    range: { start, end },
    items,
  };
  if (args.manifest) {
    await mkdir(path.dirname(path.resolve(args.manifest)), { recursive: true });
    await writeFile(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`${items.length} new draft post(s); ${candidates.length - items.length} day(s) already covered.`);

  // Inside the agentic workflow: skip the (billed) agent when there is nothing to write.
  if (items.length === 0 && process.env.GH_AW_SAFE_OUTPUTS) {
    await appendFile(
      process.env.GH_AW_SAFE_OUTPUTS,
      `${JSON.stringify({ type: 'noop', message: `All feast days through ${end} already have posts.` })}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
