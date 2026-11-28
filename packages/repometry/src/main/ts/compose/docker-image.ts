import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';

const execute = promisify(execFile);
const imageId = /^sha256:[a-f0-9]{64}$/;
const imageReference = /^[A-Za-z0-9][A-Za-z0-9.:/@_-]*$/;

export async function inspectDockerImage(image: string, base: string) {
  if (!imageReference.test(image)) throw new Error(base + ' must name a local Docker image');
  let stdout: string;
  try {
    ({ stdout } = await execute('docker', ['image', 'inspect', '--', image], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    const reason = isRecord(error) && error.code === 'ENOENT'
      ? 'requires Docker on PATH to read its image manifest' : 'could not inspect local Docker image ' + image;
    throw new Error(base + ' ' + reason, { cause: error });
  }
  const [entry] = decodeInspection(stdout, base);
  if (!isRecord(entry) || typeof entry.Id !== 'string' || !imageId.test(entry.Id)) {
    throw new Error(base + ' did not return a valid Docker image ID');
  }
  return { id: entry.Id, config: entry.Config };
}

function decodeInspection(stdout: string, base: string): readonly unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(base + ' returned invalid Docker image inspection JSON', { cause: error });
  }
  if (!Array.isArray(value) || value.length !== 1) throw new Error(base + ' did not return one local Docker image');
  return value;
}

export function dockerLabel(config: unknown, base: string): unknown {
  const labels = isRecord(config) ? config.Labels : undefined;
  const label = isRecord(labels) ? labels['repometry.plugin'] : undefined;
  if (typeof label !== 'string' || !label.trim()) throw new Error(base + ' is missing the repometry.plugin image label');
  try {
    return JSON.parse(label) as unknown;
  } catch (error) {
    throw new Error(base + ' has an invalid JSON repometry.plugin image label', { cause: error });
  }
}
