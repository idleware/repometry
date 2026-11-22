import { isRecord } from '../../../core/engine/plugin.js';

export const metaManifest = { schema: 'urn:repometry:schema:metabranch:1' } as const;

export function checkMetaManifest(text: string): void {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schema !== metaManifest.schema) throw new Error('Unsupported metabranch manifest');
}
