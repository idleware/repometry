import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cacheRoot, goParserCacheDirectory } from '../cache/root.js';
import { errorCode, privateDirectory, publishParser, readCachedParser } from './go-parser-files.js';

const staleLockMs = 120_000;

export async function cachedGoParser(key: string, deadline: number, compile: () => Promise<string>,
  root = cacheRoot()): Promise<string> {
  const cache = join(root, goParserCacheDirectory);
  try {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await privateDirectory(cache);
    return await readOrBuild(cache, key, deadline, compile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Go parser cache ${cache}: ${reason}`, { cause: error });
  }
}

async function readOrBuild(cache: string, key: string, deadline: number, compile: () => Promise<string>): Promise<string> {
  const destination = join(cache, key);
  const lock = destination + '.lock';
  for (;;) {
    const parser = await readCachedParser(destination);
    if (parser) return parser;
    if (await acquireLock(lock)) return buildWithLock(cache, destination, lock, compile);
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error('Tool timed out');
    await delay(Math.min(50, remaining));
  }
}

async function acquireLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    await removeStaleLock(lock);
    return false;
  }
}

async function removeStaleLock(lock: string): Promise<void> {
  try {
    const info = await privateDirectory(lock);
    if (Date.now() - info.mtimeMs > staleLockMs) await rmdir(lock);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function buildWithLock(cache: string, destination: string, lock: string, compile: () => Promise<string>): Promise<string> {
  try {
    return await readCachedParser(destination) ?? await publishParser(cache, destination, await compile());
  } finally {
    try {
      await rmdir(lock);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}
