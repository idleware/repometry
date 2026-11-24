import { deserialize, serialize } from 'node:v8';
import { digest } from '../model/snapshot.js';
import type { PlannedOperation } from './plan.js';
import { isRecord } from './plugin.js';
import type { Product } from './plugin.js';

export interface OperationCache {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
}

export interface OperationCacheOptions {
  readonly store: OperationCache;
  /** Digest of effective settings that the input products do not carry. */
  readonly configurationDigest: string;
}

export function operationCacheKey(task: PlannedOperation, inputs: ReadonlyMap<string, Product>, configurationDigest: string): string | undefined {
  if (task.cacheIdentity === undefined) return undefined;
  const argumentsByPort = [...inputs];
  try {
    if (argumentsByPort.some(([, { value }]) => !cacheData(value))) return undefined;
    return digest(serialize([
      'repometry.operation-cache/v1', process.version, task.key, task.cacheIdentity, configurationDigest,
      [...task.inputs], argumentsByPort,
    ]));
  } catch {
    return undefined;
  }
}

export async function readCachedOperation(store: OperationCache, key: string, task: PlannedOperation): Promise<Product | undefined> {
  try {
    const bytes = await store.read(key);
    if (!bytes) return undefined;
    const product: unknown = deserialize(bytes);
    const output = task.operation.output;
    if (isRecord(product) && product.contract === output.id && Object.hasOwn(product, 'value') && cacheData(product.value)
      && output.accepts(product.value) && (!task.validateOutput || task.validateOutput(product.value))) {
      return { contract: output.id, value: product.value };
    }
  } catch {
    // Unreadable cache entries are misses.
  }
  return undefined;
}

export async function writeCachedOperation(store: OperationCache, key: string, product: Product): Promise<void> {
  try {
    if (cacheData(product.value)) await store.write(key, serialize(product));
  } catch {
    // Cache publication is optional once an inspection has a valid result.
  }
}

function cacheData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  if (typeof value !== 'object') return ['undefined', 'boolean', 'number', 'bigint', 'string'].includes(typeof value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (ArrayBuffer.isView(value)) return prototype === Buffer.prototype || prototype === Uint8Array.prototype;
  const array = Array.isArray(value);
  if (prototype !== (array ? Array.prototype : Object.prototype)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && property !== undefined && 'value' in property
      && (property.enumerable || (array && key === 'length')) && cacheData(property.value, seen);
  });
}
