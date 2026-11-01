import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SUPPORTED_CHANNELS = ['facebook', 'instagram'];

const DEFAULTS = {
  parish: { name: 'Our Parish', hashtags: [] },
  timezone: 'America/Chicago',
  site_url: '',
  calendar: {
    source: 'gregorian',
    lookahead_days: 90,
    include_sundays: true,
    min_feast_level: 5,
    default_post_time: '07:00',
    default_channels: ['facebook', 'instagram'],
  },
  buffer: {
    organization_id: '',
    channels: { facebook: '', instagram: '' },
    schedule_window_days: 14,
  },
};

export function normalizeConfig(raw = {}) {
  const config = {
    ...DEFAULTS,
    ...raw,
    parish: { ...DEFAULTS.parish, ...raw.parish },
    calendar: { ...DEFAULTS.calendar, ...raw.calendar },
    buffer: {
      ...DEFAULTS.buffer,
      ...raw.buffer,
      channels: { ...DEFAULTS.buffer.channels, ...raw.buffer?.channels },
    },
  };
  config.site_url = String(config.site_url || '').replace(/\/+$/, '');

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
  } catch {
    throw new Error(`config: unknown timezone "${config.timezone}"`);
  }
  if (!['gregorian', 'julian'].includes(config.calendar.source)) {
    throw new Error(`config: calendar.source must be "gregorian" or "julian"`);
  }
  if (!/^\d{2}:\d{2}$/.test(config.calendar.default_post_time)) {
    throw new Error(`config: calendar.default_post_time must look like "07:00"`);
  }
  for (const channel of config.calendar.default_channels) {
    if (!SUPPORTED_CHANNELS.includes(channel)) {
      throw new Error(`config: unsupported channel "${channel}" in calendar.default_channels`);
    }
  }
  return config;
}

export async function loadConfig(root = ROOT) {
  const text = await readFile(path.join(root, 'config', 'pipeline.yml'), 'utf8');
  return normalizeConfig(YAML.parse(text) ?? {});
}
