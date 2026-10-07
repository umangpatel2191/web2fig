import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, parseGradient, parseRadius, parseShadows, splitTopLevel, tokenize, toHex } from '../shared/css.ts';

const close = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('splitTopLevel ignores commas inside parentheses', () => {
  assert.deepEqual(splitTopLevel('rgb(0, 0, 0) 0px 1px, red 2px'), ['rgb(0, 0, 0) 0px 1px', 'red 2px']);
});

test('tokenize keeps functions intact', () => {
  assert.deepEqual(tokenize('rgba(0, 0, 0, 0.5) 0px 4px 8px'), ['rgba(0, 0, 0, 0.5)', '0px', '4px', '8px']);
});

test('parseColor: rgb, rgba, space syntax, hex, srgb', () => {
  assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 });
  const c = parseColor('rgba(0, 128, 255, 0.5)')!;
  close(c.g, 128 / 255);
  assert.equal(c.a, 0.5);
  assert.equal(parseColor('rgb(0 0 0 / 25%)')!.a, 0.25);
  assert.equal(toHex(parseColor('#abc')!), '#aabbcc');
  assert.equal(parseColor('#ff000080')!.a, 128 / 255);
  assert.equal(parseColor('color(srgb 1 0 0 / 0.5)')!.a, 0.5);
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor('not-a-color'), null);
});

test('parseColor delegates unknown syntaxes to the resolver', () => {
  const r = parseColor('oklch(0.7 0.1 200)', () => ({ r: 0.1, g: 0.2, b: 0.3, a: 1 }));
  assert.equal(r!.g, 0.2);
});

test('parseShadows: multiple layers, inset, spread', () => {
  const s = parseShadows('rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, inset 0 1px 0 rgb(255, 255, 255)');
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].x, s[0].y, s[0].blur, s[0].spread, s[0].inset], [0, 4, 6, -1, false]);
  assert.equal(s[1].inset, true);
  assert.equal(parseShadows('none').length, 0);
});

test('parseRadius handles px, % and elliptical values', () => {
  assert.equal(parseRadius('8px', 100, 100), 8);
  assert.equal(parseRadius('50%', 100, 100), 50);
  assert.equal(parseRadius('50%', 200, 100), 50);
  assert.equal(parseRadius('10px 20px', 100, 100), 10);
  assert.equal(parseRadius('0px', 100, 100), 0);
});

test('linear gradient: angle, keywords and stop positions', () => {
  const g = parseGradient('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)', { w: 200, h: 100 })!;
  assert.equal(g.type, 'linear');
  if (g.type !== 'linear') return;
  assert.equal(g.angle, 90);
  assert.deepEqual(g.stops.map((s) => s.pos), [0, 1]);

  const toRight = parseGradient('linear-gradient(to right, red, blue)', { w: 10, h: 10 }, (s) => (s === 'red' ? { r: 1, g: 0, b: 0, a: 1 } : { r: 0, g: 0, b: 1, a: 1 }))!;
  assert.equal((toRight as { angle: number }).angle, 90);

  const def = parseGradient('linear-gradient(rgb(0,0,0), rgb(255,255,255))', { w: 10, h: 10 })!;
  assert.equal((def as { angle: number }).angle, 180);
});

test('gradient corner keywords follow the magic-corner rule', () => {
  const g = parseGradient('linear-gradient(to top right, rgb(0,0,0), rgb(255,255,255))', { w: 100, h: 100 })!;
  close((g as { angle: number }).angle, 45, 0.01);
});

test('gradient stops: missing positions are distributed, px converts using line length', () => {
  const g = parseGradient('linear-gradient(90deg, rgb(0,0,0), rgb(128,128,128), rgb(255,255,255))', { w: 100, h: 10 })! as { stops: { pos: number }[] };
  assert.deepEqual(g.stops.map((s) => s.pos), [0, 0.5, 1]);
  const px = parseGradient('linear-gradient(90deg, rgb(0,0,0) 0px, rgb(255,255,255) 50px)', { w: 100, h: 10 })! as { stops: { pos: number }[] };
  assert.equal(px.stops[1].pos, 0.5);
});

test('gradient: transparent stops borrow the neighbour RGB', () => {
  const g = parseGradient('linear-gradient(rgb(255, 0, 0), rgba(0, 0, 0, 0))', { w: 10, h: 10 })! as { stops: { color: { r: number; a: number } }[] };
  assert.equal(g.stops[1].color.r, 1);
  assert.equal(g.stops[1].color.a, 0);
});

test('radial gradient: position and farthest-corner ellipse', () => {
  const g = parseGradient('radial-gradient(circle at 50% 0%, rgb(0,0,0) 0%, rgb(255,255,255) 100%)', { w: 200, h: 100 })!;
  assert.equal(g.type, 'radial');
  if (g.type !== 'radial') return;
  assert.deepEqual([g.cx, g.cy], [100, 0]);
  close(g.rx, Math.hypot(100, 100));
  const e = parseGradient('radial-gradient(rgb(0,0,0), rgb(255,255,255))', { w: 200, h: 100 })! as { rx: number; ry: number };
  close(e.rx, 100 * Math.SQRT2);
  close(e.ry, 50 * Math.SQRT2);
});

test('repeating and malformed gradients are rejected', () => {
  assert.equal(parseGradient('repeating-linear-gradient(red, blue 10px)', { w: 10, h: 10 }), null);
  assert.equal(parseGradient('linear-gradient(red)', { w: 10, h: 10 }), null);
  assert.equal(parseGradient('url(x.png)', { w: 10, h: 10 }), null);
});
