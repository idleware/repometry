import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDetailed, pageAccess, publicNotice, unavailableTabs } from '../../main/ts/report/html/app/viewer-access.js';

test('the export’s own mode decides what the report shows: view and private exports are detailed, anything else is public', () => {
  assert.equal(isDetailed('local'), true);
  assert.equal(isDetailed('private'), true);
  assert.equal(isDetailed('public'), false);
  assert.equal(isDetailed(undefined), false);
  assert.equal(isDetailed(''), false);
});

test('a public report draws overview and trends, and every other page, deep links included, shows the notice', () => {
  for (const page of ['overview', 'trends']) assert.equal(pageAccess(page, false), 'open');
  for (const page of ['issues', 'hotspots', 'metrics', 'settings', 'diagnostics', 'pulls']) assert.equal(pageAccess(page, false), 'notice');
  for (const page of ['overview', 'trends', 'issues', 'metrics', 'settings']) assert.equal(pageAccess(page, true), 'open');
});

test('the unavailable tabs keep the navigation’s order, and the notice names the command that shows everything', () => {
  const html = readFileSync('src/main/resources/viewer/index.html', 'utf8');
  const order = [...html.matchAll(/<a data-page="([a-z]+)"/g)].map(match => match[1]!);
  assert.deepEqual(order.filter(page => (unavailableTabs as readonly string[]).includes(page)), [...unavailableTabs]);
  assert.equal(publicNotice.command, 'npx repometry view');
  assert.match(`${publicNotice.lead} ${publicNotice.text} ${publicNotice.command} ${publicNotice.tail}`, /^Public report: history and totals only\. .+ run npx repometry view in the repository\.$/);
});
