import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { withoutFooter } from '../../main/ts/report/html/site/export-site.js';

for (const page of ['index.html', 'projects.html']) {
  test(`--no-footer takes the footer out of ${page} and nothing else`, async () => {
    const html = await readFile(resolve('src/main/resources/viewer', page), 'utf8');
    assert.match(html, /<footer class="site-footer">/);
    const bare = withoutFooter(html);
    assert.doesNotMatch(bare, /site-footer|MIT licensed|idleware\/repometry/);
    // Everything around the footer stays as it was.
    assert.ok(bare.startsWith(html.slice(0, html.lastIndexOf('\n', html.indexOf('<footer')))));
    assert.ok(bare.endsWith(html.slice(html.indexOf('</footer>') + '</footer>'.length)));
  });
}
