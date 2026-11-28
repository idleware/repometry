import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const { workspaces } = await read('package.json');
const catalog = [];
const experimental = new Set(['@repometry/language-c', '@repometry/language-cpp', '@repometry/language-swift']);

for (const workspace of workspaces.filter(path => path.startsWith('packages/language-'))) {
  const { name } = await read(workspace + '/package.json');
  const { default: manifest } = await import(name);
  for (const { id, label, include } of manifest.languages) {
    const extensions = include.filter(pattern => /^\*\*\/\*\.[a-z0-9]+$/i.test(pattern)).map(pattern => pattern.slice(4));
    if (extensions.length > 0) catalog.push({ language: id, label, package: name,
      ...(experimental.has(name) ? { experimental: true } : {}), extensions });
  }
}

const output = JSON.stringify(catalog.sort((a, b) =>
  a.language.localeCompare(b.language) || a.package.localeCompare(b.package)), null, 2) + '\n';
const destination = new URL('packages/cli/src/main/resources/language-catalog.json', root);
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) {
    throw new Error('The language catalogue is stale. Run node scripts/generate-language-catalog.mjs after building the workspaces.');
  }
} else {
  await writeFile(destination, output, 'utf8');
}
