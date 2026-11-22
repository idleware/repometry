import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatQuery, languageOf, matches, parseQuery } from '../../main/ts/report/html/app/viewer-filter.js';
import type { FileFacts } from '../../main/ts/report/html/app/viewer-filter.js';

const file = (path: string, maximum: number | null, coverage: [number, number] | null = null) => ({
  path, lines: 10, functions: 1, complexity: maximum === null ? null : { sum: maximum, maximum, measuredFunctions: 1 },
  lineCoverage: coverage ? { covered: coverage[0], total: coverage[1] } : null, diagnosticCount: 0,
});
const facts: FileFacts = { components: new Map([['src/core/a.ts', ['Core API']]]), findings: new Map([['src/util/b.js', 2]]) };

test('the query round-trips through text, quoting names with spaces', () => {
  const clauses = parseQuery('lang:TypeScript component:"Core API" complexity>10 coverage<80% has:findings src/');
  assert.deepEqual(clauses.map(clause => clause.kind), ['lang', 'component', 'measure', 'measure', 'has', 'path']);
  assert.equal(formatQuery(clauses), 'lang:TypeScript component:"Core API" complexity>10 coverage<80% has:findings src/');
  assert.deepEqual(parseQuery('coverage<80%')[0], { kind: 'measure', measure: 'coverage', operator: '<', value: .8 });
  assert.deepEqual(parseQuery('remediation>2h')[0], { kind: 'measure', measure: 'remediation', operator: '>', value: 120 });
  assert.equal(parseQuery('unknown>3')[0], undefined);
});

test('chips of one kind widen, of different kinds narrow, and conditions must all hold', () => {
  const a = file('src/core/a.ts', 12, [7, 10]);
  const b = file('src/util/b.js', 3);
  const c = file('docs/c.md', null);
  assert.equal(languageOf(a.path), 'TypeScript');
  assert.equal(languageOf(c.path), 'MD');
  const pick = (query: string) => [a, b, c].filter(entry => matches(entry, parseQuery(query), facts)).map(entry => entry.path);
  assert.deepEqual(pick('lang:TypeScript lang:JavaScript'), ['src/core/a.ts', 'src/util/b.js']);
  assert.deepEqual(pick('lang:JavaScript has:findings'), ['src/util/b.js']);
  assert.deepEqual(pick('component:"core api"'), ['src/core/a.ts']);
  assert.deepEqual(pick('complexity>10 coverage<80%'), ['src/core/a.ts']);
  assert.deepEqual(pick('complexity>2 util'), ['src/util/b.js']);
  // A file without the measurement never passes a condition on it.
  assert.deepEqual(pick('coverage<100%'), ['src/core/a.ts']);
});
