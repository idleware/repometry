import { treeSitter } from '@repometry/tree-sitter';
import { csharp } from './csharp.js';

export { csharp };
export default treeSitter(csharp);
