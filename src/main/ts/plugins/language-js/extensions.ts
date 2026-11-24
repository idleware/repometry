import { javascriptType, typescriptType } from '../../core/model/file-types.js';

export const jsTsExtensions = [...javascriptType.extensions, ...typescriptType.extensions] as const;
