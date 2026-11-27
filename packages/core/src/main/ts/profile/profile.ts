import { isRecord } from '../engine/plugin.js';
import { normalizeFindingIgnore } from '../model/finding-ignore.js';
import { normalizeExclusions } from './exclusions.js';

export function normalizeProfile(profile: unknown) {
  if (!isRecord(profile) || Object.keys(profile).some(key => key !== 'exclude' && key !== 'ignore')) {
    throw new Error('Expected a JSON profile with optional exclude and ignore arrays');
  }
  return { exclude: normalizeExclusions(profile.exclude === undefined ? [] : profile.exclude),
    ignore: normalizeFindingIgnore(profile.ignore === undefined ? [] : profile.ignore) };
}
