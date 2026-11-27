import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitBlobHistory } from '../../main/ts/api/git/blob-history.js';

test('a history read fetches new object IDs and reloads a known ID if it now needs its contents', async () => {
  const values = new Map([
    ['first', Buffer.from('one\ntwo\n')],
    ['inventory', Buffer.from('three\n')],
    ['binary', Buffer.from([0, 1, 2])],
  ]);
  const batches: string[][] = [];
  const read = async (ids: readonly string[]) => {
    batches.push([...ids]);
    return new Map(ids.map(id => [id, values.get(id)!]));
  };
  const history = new GitBlobHistory(32);
  const source = { id: 'first', estimatedBytes: 24, contents: true };
  const inventory = { id: 'inventory', estimatedBytes: 17, contents: false };
  await history.read([source, inventory], read);
  const files = await history.read([source, inventory, { id: 'binary', estimatedBytes: 16, contents: false }], read);
  assert.deepEqual(batches, [['first'], ['inventory'], ['binary']]);
  assert.deepEqual(files.get('first'), { lines: 2, bytes: values.get('first') });
  assert.deepEqual(files.get('inventory'), { lines: 1 });
  assert.deepEqual(files.get('binary'), { lines: null });

  const promoted = await history.read([source, { ...inventory, contents: true }], read);
  assert.deepEqual(batches.at(-1), ['inventory']);
  assert.deepEqual(promoted.get('inventory'), { lines: 1, bytes: values.get('inventory') });
  await history.read([source, { id: 'binary', estimatedBytes: 16, contents: false }], read);
  assert.deepEqual(batches.at(-1), ['binary'], 'objects absent from the last snapshot are discarded');
});
