import { readFile } from 'node:fs/promises';
import { isRecord } from '../../../core/engine/plugin.js';
import type { Component } from '../wire/component-model.js';

export async function readComponents(file: string, optional: boolean): Promise<readonly Component[]> {
  try {
    const config: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(config)) throw new Error('Expected an array of component definitions');
    const names = new Set<string>();
    return config.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100
        || !Array.isArray(entry.pathGlobs) || entry.pathGlobs.length === 0 || !entry.pathGlobs.every(validPattern)
        || (entry.description !== undefined && typeof entry.description !== 'string')) {
        throw new Error('Each component requires a name and one or more root-relative pathGlobs');
      }
      const name = entry.name.trim();
      if (names.has(name)) throw new Error(`Duplicate component name: ${name}`);
      names.add(name);
      return { name, pathGlobs: [...new Set(entry.pathGlobs)], description: entry.description };
    });
  } catch (error) {
    if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function validPattern(pattern: unknown): pattern is string {
  return typeof pattern === 'string' && !/^[A-Za-z]:|[\\\0]/.test(pattern)
    && pattern.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
