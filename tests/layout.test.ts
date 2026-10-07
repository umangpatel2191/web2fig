import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAutoLayout , planWrap } from '../plugin/src/core/layout.ts';

const frame = { w: 300, h: 100 };

test('horizontal row with equal gaps and top alignment', () => {
  const p = planAutoLayout(frame, [
    { x: 20, y: 10, w: 80, h: 40 },
    { x: 116, y: 10, w: 80, h: 60 },
    { x: 212, y: 10, w: 50, h: 20 },
  ])!;
  assert.equal(p.mode, 'HORIZONTAL');
  assert.equal(p.gap, 16);
  assert.equal(p.padLeft, 20);
  assert.equal(p.padTop, 10);
  assert.equal(p.counter, 'MIN');
});

test('vertical stack', () => {
  const p = planAutoLayout({ w: 200, h: 300 }, [
    { x: 10, y: 10, w: 180, h: 50 },
    { x: 10, y: 70, w: 180, h: 50 },
    { x: 10, y: 130, w: 180, h: 50 },
  ])!;
  assert.equal(p.mode, 'VERTICAL');
  assert.equal(p.gap, 10);
  assert.equal(p.padLeft, 10);
});

test('centre-aligned row reproduces the centre line', () => {
  const p = planAutoLayout({ w: 300, h: 100 }, [
    { x: 10, y: 40, w: 50, h: 20 },
    { x: 70, y: 30, w: 50, h: 40 },
  ])!;
  assert.equal(p.counter, 'CENTER');
  // centre line y=50 == frame centre → symmetric padding
  assert.equal(p.padTop, 0);
  assert.equal(p.padBottom, 0);
});

test('uneven gaps are rejected', () => {
  assert.equal(
    planAutoLayout(frame, [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 60, y: 0, w: 50, h: 50 },
      { x: 200, y: 0, w: 50, h: 50 },
    ]),
    null,
  );
});

test('overlapping or mixed alignment is rejected', () => {
  assert.equal(planAutoLayout(frame, [{ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: 0, w: 100, h: 50 }]), null);
  assert.equal(planAutoLayout(frame, [{ x: 0, y: 0, w: 50, h: 20 }, { x: 60, y: 30, w: 50, h: 60 }]), null);
});

test('fewer than two children never converts', () => {
  assert.equal(planAutoLayout(frame, [{ x: 0, y: 0, w: 10, h: 10 }]), null);
});

test('wrapping grid of cards becomes a wrap layout', () => {
  const card = (x: number, y: number) => ({ x, y, w: 100, h: 60 });
  // 3 columns × 2 rows (+1 in the last row), 16px gaps both ways, frame 360 wide
  const kids = [card(0, 0), card(116, 0), card(232, 0), card(0, 76), card(116, 76), card(232, 76), card(0, 152)];
  const p = planWrap({ w: 332, h: 212 }, kids)!;
  assert.ok(p, 'plan exists');
  assert.equal(p.wrap, true);
  assert.equal(p.gap, 16);
  assert.equal(p.counterGap, 16);
  assert.equal(p.padLeft, 0);
  assert.equal(p.padBottom, 0);
});

test('wrap is rejected when rows are uneven', () => {
  const kids = [{ x: 0, y: 0, w: 100, h: 60 }, { x: 116, y: 0, w: 100, h: 60 }, { x: 0, y: 70, w: 100, h: 60 }, { x: 130, y: 70, w: 100, h: 60 }];
  assert.equal(planWrap({ w: 400, h: 200 }, kids), null);
});
