import type { ErrorObject } from 'ajv';

export function schemaError(base: string, error: ErrorObject | undefined): Error {
  const path = base + (error?.instancePath ?? '');
  if (error?.keyword === 'required') return new Error(path + '/' + pointer(error.params.missingProperty) + ' is required');
  if (error?.keyword === 'additionalProperties') return new Error(path + '/' + pointer(error.params.additionalProperty) + ' is not allowed');
  if (error?.keyword === 'enum') {
    const values = error.params.allowedValues as readonly unknown[];
    return new Error(path + ' must be one of ' + values.map(value => JSON.stringify(value)).join(', '));
  }
  return new Error(path + ' ' + (error?.message ?? 'is invalid'));
}

function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
