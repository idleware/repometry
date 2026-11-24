import { readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { checkDirectory, ensureDirectory, hasCode } from './directory.js';
import { replaceFile } from './replace-file.js';
import { ObjectError, objectPath, objectText, storedObjects } from './report-tree.js';
import type { ObjectCache } from './report-tree.js';
import type { ObjectSource } from './report-tree.js';

/** Content-addressed report objects under `<store>/objects`. Objects are immutable: a valid one is never rewritten. */
export class LocalObjectStore {
  constructor(private readonly directory: string) {}

  source(cache?: ObjectCache): ObjectSource {
    return storedObjects(ids => Promise.all(ids.map(id => this.bytes(id))), cache);
  }

  /** Writes each object that is missing or fails its check. */
  async write(objects: ReadonlyMap<string, string>): Promise<void> {
    await ensureDirectory(join(this.directory, 'objects'));
    await Promise.all([...objects].map(async ([id, text]) => {
      if (await this.valid(id)) return;
      const path = join(this.directory, objectPath(id));
      await ensureDirectory(dirname(path));
      await replaceFile(dirname(path), basename(path), text);
    }));
  }

  async valid(id: string): Promise<boolean> {
    try {
      objectText(id, await this.bytes(id));
      return true;
    } catch (error) {
      if (error instanceof ObjectError) return false;
      throw error;
    }
  }

  async bytes(id: string): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.directory, objectPath(id)));
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async ids(): Promise<readonly string[]> {
    const root = join(this.directory, 'objects');
    try {
      await checkDirectory(root);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const ids: string[] = [];
    for (const fanout of await readdir(root)) {
      if (!/^[a-f0-9]{2}$/.test(fanout)) continue;
      for (const name of await readdir(join(root, fanout))) {
        const match = /^([a-f0-9]{32}-[a-f0-9]{8})\.json$/.exec(name);
        if (match?.[1]) ids.push(match[1]);
      }
    }
    return ids;
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.directory, objectPath(id)), { force: true });
  }
}
