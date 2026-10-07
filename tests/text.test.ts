import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLines } from '../extension/src/content/text.ts';
import { bgPosition } from '../extension/src/content/style.ts';

const line = (left: number, right: number) => ({ left, right });

test('lines sharing the left edge stay one multi-line text layer', () => {
  const g = groupLines([line(40, 400), line(40, 380), line(40, 220)], 'left');
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 3);
});

test('an inline run that starts mid-line is split from the lines below it (overlapping-text bug)', () => {
  // "Flexible solutions. <span>Run your business… " → first line starts at x=213, the rest at x=0
  const g = groupLines([line(213, 503), line(0, 517), line(0, 400)], 'left');
  assert.equal(g.length, 2);
  assert.equal(g[0].length, 1);
  assert.equal(g[0][0].left, 213);
  assert.equal(g[1].length, 2);
});

test('centred text groups by centre, right-aligned text by right edge', () => {
  assert.equal(groupLines([line(100, 300), line(150, 250)], 'center').length, 1);
  assert.equal(groupLines([line(100, 300), line(180, 300)], 'right').length, 1);
  assert.equal(groupLines([line(100, 300), line(180, 320)], 'right').length, 2);
});

test('background-position understands calc() produced by `right 10px bottom 10px`', () => {
  assert.equal(bgPosition('calc(100% - 10px)', 158), 148);
  assert.equal(bgPosition('calc(50% + 4px)', 100), 54);
  assert.equal(bgPosition('25%', 200), 50);
  assert.equal(bgPosition('12px', 200), 12);
});
