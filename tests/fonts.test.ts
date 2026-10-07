import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FontIndex, pickStyle, styleWeight } from '../plugin/src/core/font-match.ts';

const idx = new FontIndex([
  ...['Thin', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black', 'Italic', 'Bold Italic'].map((style) => ({ family: 'Inter', style })),
  ...['Regular', 'Bold'].map((style) => ({ family: 'Georgia', style })),
  { family: 'Roboto Mono', style: 'Regular' },
  { family: 'Poppins', style: 'Regular' },
  { family: 'Poppins', style: 'SemiBold' },
]);

test('styleWeight parses common style names', () => {
  assert.equal(styleWeight('Semi Bold'), 600);
  assert.equal(styleWeight('ExtraBold Italic'), 800);
  assert.equal(styleWeight('Extra Light'), 200);
  assert.equal(styleWeight('Regular'), 400);
});

test('exact family and weight', () => {
  assert.deepEqual(idx.match(['Inter', 'sans-serif'], 600, false).font, { family: 'Inter', style: 'SemiBold' });
});

test('nearest available weight within the family', () => {
  assert.equal(idx.match(['Poppins'], 700, false).font.style, 'SemiBold');
});

test('italic preference', () => {
  assert.equal(idx.match(['Inter'], 700, true).font.style, 'Bold Italic');
});

test('missing brand font is reported and falls back to Inter', () => {
  const m = idx.match(['Neue Haas Grotesk', 'Helvetica', 'sans-serif'], 400, false);
  assert.equal(m.missing, 'Neue Haas Grotesk');
  assert.equal(m.font.family, 'Inter');
});

test('generic stacks do not count as missing fonts', () => {
  const m = idx.match(['system-ui', '-apple-system', 'sans-serif'], 400, false);
  assert.equal(m.missing, undefined);
  assert.equal(m.font.family, 'Inter');
});

test('serif and monospace generics map to sensible fonts', () => {
  assert.equal(idx.match(['serif'], 400, false).font.family, 'Georgia');
  assert.equal(idx.match(['ui-monospace', 'monospace'], 400, false).font.family, 'Roboto Mono');
});

test('pickStyle handles empty lists', () => {
  assert.equal(pickStyle([], 400, false), null);
});
