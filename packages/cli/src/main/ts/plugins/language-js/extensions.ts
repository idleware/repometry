import { javascriptType, typescriptType } from '@repometry/core/internal/model/file-types.js';

export const jsTsExtensions = [...javascriptType.extensions, ...typescriptType.extensions] as const;
