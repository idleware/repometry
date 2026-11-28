import { treeSitter } from '@repometry/tree-sitter';
import { cpp, cppExtensions } from './cpp.js';

export { cpp };

// The runtime accepts .h after an explicit include, while the manifest advertises only definite C++ suffixes.
const parser = treeSitter({ ...cpp, language: { ...cpp.language, extensions: [...cppExtensions, '.h'] } });
const manifest: ReturnType<typeof treeSitter> = { ...parser, languages: parser.languages?.map(language => ({
  ...language, include: language.include.filter(pattern => pattern !== '**/*.h'),
})) };

export default manifest;
