/**
 * Auto Layout inference from geometry.
 *
 * We never guess from CSS. We look at where the children actually ended up and only convert a
 * frame when Auto Layout can reproduce those exact positions. The caller verifies the result
 * after applying it and reverts if Figma disagrees.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CounterAlign = 'MIN' | 'CENTER' | 'MAX';

export interface LayoutPlan {
  mode: 'HORIZONTAL' | 'VERTICAL';
  gap: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
  counter: CounterAlign;
  /** Rows that wrap (flex-wrap / grid of equal cards). `gap` is the gap inside a row. */
  wrap?: boolean;
  /** Gap between wrapped rows. */
  counterGap?: number;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

function plan1D(frame: { w: number; h: number }, kids: Box[], horizontal: boolean, tol: number): LayoutPlan | null {
  const pos = (b: Box) => (horizontal ? b.x : b.y);
  const len = (b: Box) => (horizontal ? b.w : b.h);
  const cpos = (b: Box) => (horizontal ? b.y : b.x);
  const clen = (b: Box) => (horizontal ? b.h : b.w);
  const mainSize = horizontal ? frame.w : frame.h;
  const crossSize = horizontal ? frame.h : frame.w;

  // Children must follow each other along the main axis, in order, without overlapping.
  const gaps: number[] = [];
  for (let i = 1; i < kids.length; i++) {
    const g = pos(kids[i]) - (pos(kids[i - 1]) + len(kids[i - 1]));
    if (g < -tol) return null;
    gaps.push(Math.max(0, g));
  }
  if (Math.max(...gaps) - Math.min(...gaps) > 1) return null;
  const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  const startPad = pos(kids[0]);
  if (startPad < -tol) return null;
  const last = kids[kids.length - 1];
  const endPad = Math.max(0, mainSize - (pos(last) + len(last)));

  // Cross-axis alignment shared by every child.
  const tops = kids.map(cpos);
  const bottoms = kids.map((k) => cpos(k) + clen(k));
  const centers = kids.map((k) => cpos(k) + clen(k) / 2);
  const all = (arr: number[]) => arr.every((v) => near(v, arr[0], tol));

  let counter: CounterAlign;
  let crossStart = 0;
  let crossEnd = 0;
  if (all(tops)) {
    counter = 'MIN';
    crossStart = Math.max(0, Math.min(...tops));
    crossEnd = Math.max(0, crossSize - Math.max(...bottoms));
  } else if (all(bottoms)) {
    counter = 'MAX';
    crossEnd = Math.max(0, crossSize - Math.max(...bottoms));
    crossStart = Math.max(0, Math.min(...tops));
  } else if (all(centers)) {
    counter = 'CENTER';
    const c = centers[0];
    // Pick symmetrical-in-effect padding so the centre line lands exactly on c.
    if (2 * c <= crossSize) {
      crossStart = 0;
      crossEnd = crossSize - 2 * c;
    } else {
      crossStart = 2 * c - crossSize;
      crossEnd = 0;
    }
  } else return null;

  return horizontal
    ? { mode: 'HORIZONTAL', gap, padLeft: startPad, padRight: endPad, padTop: crossStart, padBottom: crossEnd, counter }
    : { mode: 'VERTICAL', gap, padTop: startPad, padBottom: endPad, padLeft: crossStart, padRight: crossEnd, counter };
}

/**
 * Rows that wrap: every row starts at the same x, items inside a row are evenly spaced and aligned, and the rows are
 * evenly spaced. Returns null for anything else (the caller verifies the result in Figma anyway).
 */
export function planWrap(frame: { w: number; h: number }, kids: Box[], tol = 0.75): LayoutPlan | null {
  if (kids.length < 4) return null;
  const rows: Box[][] = [[kids[0]]];
  for (let i = 1; i < kids.length; i++) {
    const prev = kids[i - 1];
    const k = kids[i];
    // a wrapped item starts back at the left, i.e. it is not placed after the previous one
    if (k.x < prev.x + prev.w - tol) rows.push([k]);
    else rows[rows.length - 1].push(k);
  }
  if (rows.length < 2 || !rows.some((r) => r.length >= 2)) return null;

  const startX = rows[0][0].x;
  if (!rows.every((r) => near(r[0].x, startX, tol))) return null;

  // one cross-axis alignment shared by every row
  const aligns: CounterAlign[] = ['MIN', 'CENTER', 'MAX'];
  const aligned = (a: CounterAlign) =>
    rows.every((r) => {
      const v = r.map((b) => (a === 'MIN' ? b.y : a === 'MAX' ? b.y + b.h : b.y + b.h / 2));
      return v.every((x) => near(x, v[0], tol));
    });
  const counter = aligns.find(aligned);
  if (!counter) return null;

  const gaps: number[] = [];
  for (const r of rows) for (let i = 1; i < r.length; i++) gaps.push(r[i].x - (r[i - 1].x + r[i - 1].w));
  if (gaps.length === 0 || gaps.some((g) => g < -tol) || Math.max(...gaps) - Math.min(...gaps) > 1) return null;
  const gap = Math.max(0, gaps.reduce((a, b) => a + b, 0) / gaps.length);

  const top = (r: Box[]) => Math.min(...r.map((b) => b.y));
  const bottom = (r: Box[]) => Math.max(...r.map((b) => b.y + b.h));
  const vgaps: number[] = [];
  for (let i = 1; i < rows.length; i++) vgaps.push(top(rows[i]) - bottom(rows[i - 1]));
  if (vgaps.some((g) => g < -tol) || Math.max(...vgaps) - Math.min(...vgaps) > 1) return null;
  const counterGap = Math.max(0, vgaps.reduce((a, b) => a + b, 0) / vgaps.length);

  const right = Math.max(...kids.map((b) => b.x + b.w));
  return {
    mode: 'HORIZONTAL',
    wrap: true,
    gap,
    counterGap,
    padLeft: startX,
    padRight: Math.max(0, frame.w - right),
    padTop: Math.max(0, top(rows[0])),
    padBottom: Math.max(0, frame.h - bottom(rows[rows.length - 1])),
    counter,
  };
}

/**
 * `kids` are the in-flow children in z-order (the order Figma will lay them out).
 * Returns null when no faithful Auto Layout exists.
 */
export function planAutoLayout(frame: { w: number; h: number }, kids: Box[], tol = 0.75): LayoutPlan | null {
  if (kids.length < 2) return null;
  const overlapY = kids.reduce((s, k) => s + Math.max(0, Math.min(k.y + k.h, kids[0].y + kids[0].h) - Math.max(k.y, kids[0].y)), 0);
  const overlapX = kids.reduce((s, k) => s + Math.max(0, Math.min(k.x + k.w, kids[0].x + kids[0].w) - Math.max(k.x, kids[0].x)), 0);
  const order: boolean[] = overlapY >= overlapX ? [true, false] : [false, true];
  for (const horizontal of order) {
    const p = plan1D(frame, kids, horizontal, tol);
    if (p) return p;
  }
  return planWrap(frame, kids, tol);
}
