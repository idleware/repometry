import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSourceLayer, lineStates } from '../../main/ts/report/html/app/viewer-source.js';

test('coverage ranges become one state per measured line, 1-based and inclusive, and unnamed lines stay unmeasured', () => {
  const states = lineStates({ covered: [[1, 3], [7, 7]], uncovered: [[5, 6]], partial: [[2, 2]] });
  assert.deepEqual([...Array(8).keys()].map(index => states.get(index + 1) ?? null),
    ['covered', 'partial', 'covered', null, 'uncovered', 'uncovered', 'covered', null]);
});

test('where ranges overlap the worse state wins, and a file without partial lines reads as covered and missed only', () => {
  const states = lineStates({ covered: [[1, 4]], uncovered: [[3, 3]], partial: [[3, 4]] });
  assert.deepEqual([1, 2, 3, 4].map(line => states.get(line)), ['covered', 'covered', 'uncovered', 'partial']);
  assert.deepEqual([...lineStates({ covered: [[2, 2]], uncovered: [] })], [[2, 'covered']]);
  assert.equal(lineStates({ covered: [[0, 1]], uncovered: [] }).has(0), false);
});

test('only the two layers a source view knows are taken from the URL', () => {
  assert.equal(isSourceLayer('coverage'), true);
  assert.equal(isSourceLayer('issues'), true);
  for (const value of ['', 'Coverage', 'lines', null, undefined]) assert.equal(isSourceLayer(value), false);
});

test('hit runs give each measured line its count, and a report without them gives none', async () => {
  const { lineHits } = await import('../../main/ts/report/html/app/viewer-source.js');
  const hits = lineHits({ covered: [[1, 2]], uncovered: [[3, 3]], hits: [[1, 1, 12], [2, 2, 1], [3, 3, 0]] } as never);
  assert.deepEqual([...hits], [[1, 12], [2, 1], [3, 0]]);
  assert.equal(lineHits({ covered: [[1, 2]], uncovered: [] }).size, 0);
});

test('a count is short in the gutter and whole in the words a pointer or a screen reader gets', async () => {
  const { hitLabel, lineCoverageText } = await import('../../main/ts/report/html/app/viewer-source.js');
  assert.deepEqual([0, 3, 980, 1234, 45_000, 265_700, 3_400_000].map(hitLabel), ['0×', '3×', '980×', '1.2K×', '45K×', '270K×', '3.4M×']);
  assert.equal(lineCoverageText('covered', 1), 'Covered. Ran 1 time');
  assert.match(lineCoverageText('partial', 1234), /^Partly covered: some branches missed\. Ran 1.234 times$/);
  assert.equal(lineCoverageText('uncovered', 0), 'Not covered');
  assert.equal(lineCoverageText('covered'), 'Covered');
});

test('blank and comment-only lines carry no code, so coverage gives them no count', async () => {
  const { codeless, tokenizer } = await import('../../main/ts/report/html/app/viewer-source.js');
  const tokenize = tokenizer('a.ts');
  const lines = ['', '   ', '// note', '/**', ' * a doc line', ' */', 'const a = 1; // trailing', '}', '  /* inline */ run();'];
  assert.deepEqual(lines.map(line => codeless(tokenize(line))), [true, true, true, true, true, true, false, false, false]);
  assert.equal(codeless(tokenizer('notes.txt')('# not a comment here')), false);
});

test('a gap of blank and comment lines takes the tint of a run it sits inside, and stays plain between different states', async () => {
  const { bridgeStates } = await import('../../main/ts/report/html/app/viewer-source.js');
  // Lines 1–12: covered, blank, covered, blank blank, uncovered, blank, uncovered, blank, code no one measured, blank, covered.
  const states = new Map([[1, 'covered'], [3, 'covered'], [6, 'uncovered'], [8, 'uncovered'], [12, 'covered']] as const);
  const codeless = [false, true, false, true, true, false, true, false, true, false, true, false];
  assert.deepEqual([...bridgeStates(new Map(states), codeless)], [[2, 'covered'], [7, 'uncovered']]);
  // At the file's start and end a gap has one side only, so it stays plain.
  assert.equal(bridgeStates(new Map([[2, 'covered']] as const), [true, false, true]).size, 0);
});
