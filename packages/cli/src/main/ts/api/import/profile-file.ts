import { readFile } from 'node:fs/promises';
import { normalizeProfile } from '@repometry/core/internal/profile/profile.js';

export async function readProfile(file: string | undefined, optional = false) {
  if (file === undefined) return { exclude: [], ignore: [] };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exclude: [], ignore: [] };
    throw error;
  }
  return normalizeProfile(JSON.parse(text) as unknown);
}
