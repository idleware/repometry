import { Ajv2020 } from 'ajv/dist/2020.js';
import { isRecord } from '@repometry/core/internal/engine/plugin.js';
import type { PluginConfigSchema } from '@repometry/core/internal/engine/plugin.js';
import { schemaError } from './schema-error.js';
import type { JsonValue } from '@repometry/core/internal/model/plugin-data.js';

export function validatePluginOptions(schema: unknown, value: JsonValue | undefined, base: string): JsonValue | undefined {
  if (schema === undefined) {
    if (value !== undefined) throw new Error(base + '/options is not accepted by this plugin');
    return undefined;
  }
  if (value === undefined && schema === false) return undefined;
  const validate = compileSchema(schema, base);
  const options = value === undefined ? {} : value;
  if (!validate(options)) throw schemaError(base + '/options', validate.errors?.[0]);
  return options;
}

function compileSchema(schema: unknown, base: string) {
  if (typeof schema !== 'boolean' && !isRecord(schema)) throw new Error(base + ' declares an invalid options schema');
  try {
    return new Ajv2020({ strict: false, ownProperties: true }).compile(schema as PluginConfigSchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(base + ' declares an invalid options schema: ' + message, { cause: error });
  }
}
