import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTimeline, nextSegment, wholeCycle, MAX_PLAY } from '../docs/js/player.js';

const take = (tl, k) => Array.from({ length: k }, () => tl.next());

test('timeline repeats frames and follows each mode', () => {
  assert.deepEqual(take(makeTimeline(3, 2, 'once'), 8), [0, 0, 1, 1, 2, 2, null, null]);
  assert.deepEqual(take(makeTimeline(3, 1, 'loop'), 7), [0, 1, 2, 0, 1, 2, 0]);
  assert.deepEqual(take(makeTimeline(4, 1, 'pingpong'), 9), [0, 1, 2, 3, 2, 1, 0, 1, 2]);
  assert.deepEqual(take(makeTimeline(4, 1, 'once', 2), 3), [2, 3, null]);
});

test('segments end with a duplicate so a late follow-up never jumps back', () => {
  const tl = makeTimeline(12, 1, 'once');
  const a = nextSegment(tl);
  assert.deepEqual(a, { entries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 8], ticks: 9 });
  const b = nextSegment(tl);
  assert.deepEqual(b, { entries: [9, 10, 11, 11], ticks: 3 });
  assert.equal(nextSegment(tl), null);
  assert.ok(a.entries.length <= MAX_PLAY);
});

test('short repeating cycles are handed to the mask whole', () => {
  assert.deepEqual(wholeCycle(4, 1, 'pingpong'), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(wholeCycle(5, 2, 'loop'), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(wholeCycle(6, 2, 'loop'), null); // 12 entries: too long
  assert.equal(wholeCycle(3, 1, 'once'), null);
});
