import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeStates, callReading, hitLabel, isSourceLayer, lineCoverageText, lineHits, lineReadings, lineStates } from '../../main/ts/report/html/app/viewer-line-coverage.js';
import { codeless, tokenizer } from '../../main/ts/report/html/app/viewer-tokenizer.js';

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

test('hit runs give each measured line its count, and a report without them gives none', () => {
  const hits = lineHits({ covered: [[1, 2]], uncovered: [[3, 3]], hits: [[1, 1, 12], [2, 2, 1], [3, 3, 0]] } as never);
  assert.deepEqual([...hits], [[1, 12], [2, 1], [3, 0]]);
  assert.equal(lineHits({ covered: [[1, 2]], uncovered: [] }).size, 0);
});

test('a count is short in the gutter and whole in the words a pointer or a screen reader gets', () => {
  assert.deepEqual([0, 3, 980, 1234, 45_000, 265_700, 3_400_000].map(hitLabel), ['0×', '3×', '980×', '1.2K×', '45K×', '270K×', '3.4M×']);
  assert.equal(lineCoverageText('covered', 1), 'Covered. Ran 1 time');
  assert.match(lineCoverageText('partial', 1234), /^Partly covered: some branches missed\. Ran 1.234 times$/);
  assert.equal(lineCoverageText('uncovered', 0), 'Not covered');
  assert.equal(lineCoverageText('covered'), 'Covered');
});

test('blank and comment-only lines carry no code, so coverage gives them no count', () => {
  const tokenize = tokenizer('a.ts');
  const lines = ['', '   ', '// note', '/**', ' * a doc line', ' */', 'const a = 1; // trailing', '}', '  /* inline */ run();'];
  assert.deepEqual(lines.map(line => codeless(tokenize(line))), [true, true, true, true, true, true, false, false, false]);
  assert.equal(codeless(tokenizer('notes.txt')('# not a comment here')), false);
});

test('a gap of blank and comment lines takes the tint of the line above it, so the strip never breaks', () => {
  // Lines 1–12: covered, blank, covered, blank blank, uncovered, blank, uncovered, blank, code no one measured, blank, covered.
  const states = new Map([[1, 'covered'], [3, 'covered'], [6, 'uncovered'], [8, 'uncovered'], [12, 'covered']] as const);
  const codeless = [false, true, false, true, true, false, true, false, true, false, true, false];
  assert.deepEqual([...bridgeStates(new Map(states), codeless)],
    [[2, 'covered'], [4, 'covered'], [5, 'covered'], [7, 'uncovered'], [9, 'uncovered'], [11, 'covered']]);
  // A gap at the file's start takes the line below; one at its end, the line above; one with no measured side, nothing.
  assert.deepEqual([...bridgeStates(new Map([[2, 'covered']] as const), [true, false, true])], [[1, 'covered'], [3, 'covered']]);
  assert.equal(bridgeStates(new Map(), [true, true]).size, 0);
});

// github.ts as the inspection records it: two functions never called, one called once, each declaration line run twice
// because the module was loaded twice.
const github = {
  covered: [[1, 7], [17, 18], [30, 31]], uncovered: [[8, 16], [19, 29], [32, 33]],
  hits: [[1, 7, 2], [8, 16, 0], [17, 18, 2], [19, 29, 0], [30, 31, 2], [32, 32, 1], [33, 33, 0]],
  functionCalls: [[7, 0], [18, 0], [31, 1]], functionBodies: [[8, 15], [19, 28], [32, 33]],
} as const;

test('a declaration line reads as its function\'s calls, not as the module loads that ran it', () => {
  const readings = lineReadings(github as never);
  assert.deepEqual(readings.get(7), { state: 'uncovered', text: 'Not called' });
  assert.deepEqual(readings.get(31), { state: 'covered', count: 1, text: 'Called 1 time' });
});

test('module-level lines keep their tint without a number; lines inside a body show how often they ran', () => {
  const readings = lineReadings(github as never);
  assert.deepEqual(readings.get(1), { state: 'covered', text: 'Covered' });
  assert.deepEqual(readings.get(17), { state: 'covered', text: 'Covered' });
  assert.deepEqual(readings.get(32), { state: 'uncovered', count: 1, text: 'Not covered' });
  assert.deepEqual(readings.get(9), { state: 'uncovered', count: 0, text: 'Not covered' });
});

test('a report without function bodies keeps counting every line, as before', () => {
  const { functionBodies: _, ...old } = github;
  const readings = lineReadings({ ...old, functionCalls: undefined } as never);
  assert.deepEqual(readings.get(7), { state: 'covered', count: 2, text: 'Covered. Ran 2 times' });
  assert.deepEqual(lineReadings({ ...github, functionBodies: [] } as never).get(1), { state: 'covered', text: 'Covered' });
});

test('functions starting on one line are called, partly called or not called together', () => {
  assert.deepEqual(callReading([3, 2]), { state: 'covered', count: 5, text: 'Called 5 times' });
  assert.deepEqual(callReading([0, 0]), { state: 'uncovered', text: 'Not called: none of the 2 functions here ran' });
  assert.deepEqual(callReading([4, 0]), { state: 'partial', count: 4, text: 'Partly called: 1 of the 2 functions here never ran. Called 4 times' });
});
