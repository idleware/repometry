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
