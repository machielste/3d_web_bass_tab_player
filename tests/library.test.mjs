import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange, ROW_HEIGHT } from '../static/virtual-list.js';

test('a large library mounts only the viewport and a small overscan', () => {
  for (const total of [5000, 100000]) {
    const range = visibleRange(2000 * ROW_HEIGHT + 37, 720, total);
    assert.equal(range.start, 1996);
    assert.equal(range.end, 2014);
    assert.ok(range.end - range.start <= 18);
  }
});

test('virtual ranges clamp at both ends and for an empty library', () => {
  assert.deepEqual(visibleRange(0, 720, 0), { start: 0, end: 0 });
  assert.deepEqual(visibleRange(-20, 160, 100), { start: 0, end: 6 });
  assert.deepEqual(visibleRange(99 * ROW_HEIGHT, 720, 100), { start: 95, end: 100 });
  assert.deepEqual(visibleRange(10000, 720, 3), { start: 3, end: 3 });
});
