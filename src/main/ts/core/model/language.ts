import type { StructureMeasure } from './code-structure.js';
import { isRecord } from './plugin-data.js';

export interface LanguageDisplay {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
}

export interface LanguageLookup {
  readonly catalog: readonly LanguageDisplay[];
  id(path: string): string;
}

export interface ProvidedLanguage extends LanguageDisplay {
  readonly extensions?: readonly string[];
  readonly globs?: readonly string[];
  readonly measures?: readonly StructureMeasure[];
}

export function isLanguageDisplay(value: unknown): value is LanguageDisplay {
  return isRecord(value) && typeof value.id === 'string' && /^[a-z][a-z0-9-]*$/.test(value.id)
    && typeof value.label === 'string' && value.label.trim().length > 0
    && (value.color === undefined || typeof value.color === 'string' && /^#[a-f\d]{6}$/i.test(value.color));
}
