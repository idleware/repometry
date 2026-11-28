import { posix } from 'node:path';
import type { ProvidedLanguage } from './language.js';
import { cppSyntax, cssSyntax, cSyntax, dockerfileSyntax, jsonSyntax } from './file-type-syntax.js';

interface FileType extends ProvidedLanguage {
  readonly names?: readonly string[];
  readonly exactNames?: readonly string[];
}

export const javascriptType = { id: 'javascript', label: 'JavaScript', color: '#f1e05a', extensions: ['.js', '.mjs', '.cjs', '.jsx'] } as const;
export const typescriptType = { id: 'typescript', label: 'TypeScript', color: '#3178c6', extensions: ['.ts', '.mts', '.cts', '.tsx'] } as const;

export const fileTypes: readonly FileType[] = [
  javascriptType, typescriptType,
  { id: 'markdown', label: 'Markdown', color: '#768390', extensions: ['.md', '.mdx', '.markdown'] },
  { id: 'yaml', label: 'YAML', color: '#c47d84', extensions: ['.yaml', '.yml'] },
  { id: 'json', label: 'JSON', color: '#9b86b5', extensions: ['.json'], syntax: jsonSyntax },
  { id: 'css', label: 'CSS', color: '#663399', extensions: ['.css'], syntax: cssSyntax },
  { id: 'scss', label: 'SCSS', color: '#c6538c', extensions: ['.scss'] },
  { id: 'less', label: 'Less', color: '#1d365d', extensions: ['.less'] },
  { id: 'html', label: 'HTML', color: '#e34c26', extensions: ['.html', '.htm'] },
  { id: 'shell', label: 'Shell', color: '#89e051', extensions: ['.sh', '.bash', '.zsh', '.fish'], names: ['.bashrc', '.bash_profile'] },
  { id: 'batch', label: 'Batch', color: '#788f32', extensions: ['.bat'] },
  { id: 'dockerfile', label: 'Dockerfile', color: '#4f9a94', names: ['dockerfile', 'containerfile'],
    extensions: ['.dockerfile'], syntax: dockerfileSyntax },
  { id: 'python', label: 'Python', color: '#3572a5', extensions: ['.py'] },
  { id: 'go', label: 'Go', color: '#00add8', extensions: ['.go'] },
  { id: 'go-module', label: 'Go module', color: '#008ba8', exactNames: ['go.mod'] },
  { id: 'go-checksums', label: 'Go checksums', color: '#487b91', exactNames: ['go.sum'] },
  { id: 'rust', label: 'Rust', color: '#dea584', extensions: ['.rs'] },
  { id: 'java', label: 'Java', color: '#b07219', extensions: ['.java'] },
  { id: 'kotlin', label: 'Kotlin', color: '#a97bff', extensions: ['.kt', '.kts'] },
  { id: 'ruby', label: 'Ruby', color: '#701516', extensions: ['.rb'] },
  { id: 'php', label: 'PHP', color: '#4f5d95', extensions: ['.php'] },
  { id: 'csharp', label: 'C#', color: '#178600', extensions: ['.cs'] },
  { id: 'c', label: 'C', color: '#555555', extensions: ['.c', '.h'], syntax: cSyntax },
  { id: 'cpp', label: 'C++', color: '#f34b7d', extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh'], syntax: cppSyntax },
  { id: 'swift', label: 'Swift', color: '#f05138', extensions: ['.swift'] },
  { id: 'scala', label: 'Scala', color: '#c22d40', extensions: ['.scala'] },
  { id: 'vue', label: 'Vue', color: '#41b883', extensions: ['.vue'] },
  { id: 'svelte', label: 'Svelte', color: '#ff3e00', extensions: ['.svelte'] },
  { id: 'text', label: 'Plain text', color: '#7b8794', extensions: ['.txt'] },
  { id: 'lockfile', label: 'Lockfile', color: '#d2c3a3', exactNames: [
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
    'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'flake.lock',
    'mix.lock', 'pubspec.lock', 'packages.lock.json', 'gradle.lockfile',
  ] },
  { id: 'other', label: 'Other', exactNames: ['py.typed'] },
];

const extensions = new Map(fileTypes.flatMap(({ id, extensions }) => extensions?.map(ext => [ext, id] as const) ?? []));
const names = new Map(fileTypes.flatMap(({ id, names }) => names?.map(name => [name, id] as const) ?? []));

const exactNames = new Map(fileTypes.flatMap(({ id, exactNames }) => exactNames?.map(name => [name, id] as const) ?? []));

export function fileTypeId(path: string, fallback?: string): string {
  const basename = posix.basename(path);
  const name = basename.toLowerCase();
  const extension = posix.extname(name);
  return exactNames.get(basename) ?? names.get(name) ?? names.get(name.split('.', 1)[0]!) ?? extensions.get(extension)
    ?? fallback ?? (extension.slice(1) || 'other');
}

export function canonicalFileTypeId(id: string): string {
  return id === 'c-sharp' ? 'csharp' : id;
}
