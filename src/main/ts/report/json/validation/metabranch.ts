import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import schema from '../../../../resources/report/json/metabranch-v1.schema.json' with { type: 'json' };

export const metaManifest = { schema: schema.$id } as const;

let validate: ValidateFunction | undefined;

export function checkMetaManifest(text: string): void {
  const value: unknown = JSON.parse(text);
  const check = validate ??= new Ajv2020().compile(schema);
  if (!check(value)) throw new Error('Unsupported metabranch manifest');
}
