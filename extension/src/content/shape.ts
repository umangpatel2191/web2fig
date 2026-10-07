import { parseGradient, round, splitTopLevel, tokenize } from '../../../shared/css';
import type { ClipShape, Corners, Paint } from '../../../shared/schema';
import type { Ctx } from './context';

/**
 * CSS `clip-path` basic shapes and `mask-image` gradients, expressed in the element's own pixel space
 * (origin = top-left of its border box) so the plugin can rebuild them as native Figma masks.
 */

type Len = (tok: string, total: number) => number | null;

const len: Len = (tok, total) => {
  const t = tok.trim();
  if (/^-?[\d.]+%$/.test(t)) return (parseFloat(t) / 100) * total;
  if (/^-?[\d.]+(px)?$/.test(t)) return parseFloat(t);
  return null; // calc(), em… (computed values are normally already px / %)
};

function position(tokens: string[], W: number, H: number): [number, number] | null {
  const kw = (t: string, total: number, axis: 'x' | 'y'): number | null => {
    if (t === 'center') return total / 2;
    if (axis === 'x' && t === 'left') return 0;
    if (axis === 'x' && t === 'right') return total;
    if (axis === 'y' && t === 'top') return 0;
    if (axis === 'y' && t === 'bottom') return total;
    return len(t, total);
  };
  const [a = 'center', b = 'center'] = tokens;
  // `top left` order is also legal
  const swap = (a === 'top' || a === 'bottom') && (b === 'left' || b === 'right');
  const [xt, yt] = swap ? [b, a] : [a, b];
  const x = kw(xt, W, 'x');
  const y = kw(yt, H, 'y');
  return x === null || y === null ? null : [x, y];
}

function radii(tokens: string[], W: number, H: number): Corners | null {
  const vals = tokens.map((t) => len(t, Math.min(W, H)));
  if (vals.some((v) => v === null) || vals.length === 0) return null;
  const v = vals as number[];
  const [tl, tr = tl, br = tl, bl = tr] = v;
  return [tl, tr, br, bl].map((n) => Math.max(0, round(n))) as Corners;
}

/** Returns a shape, 'hidden' when the clip leaves nothing visible, or null when it can't be expressed. */
export function readClipShape(cs: CSSStyleDeclaration, W: number, H: number): ClipShape | 'hidden' | null {
  const raw = cs.clipPath;
  if (!raw || raw === 'none') return null;
  const m = /^(inset|circle|ellipse|polygon|path)\(([\s\S]*)\)\s*(?:(?:border|padding|content|margin|fill|stroke|view)-box|\s)*$/i.exec(raw.trim());
  if (!m) return null; // url(#svg-clip), shape(), geometry-box only…
  const kind = m[1].toLowerCase();
  const body = m[2].trim();

  if (kind === 'inset') {
    const [edgesPart, roundPart] = body.split(/\s+round\s+/i);
    const e = tokenize(edgesPart).map((t) => len(t, 0));
    if (e.length === 0 || e.some((v) => v === null)) return null;
    const ex = tokenize(edgesPart);
    const pick = (i: number, total: number) => {
      const t = ex[i % ex.length] ?? ex[0];
      return len(t, total) ?? 0;
    };
    // top right bottom left, CSS shorthand rules; percentages: top/bottom of H, left/right of W
    const top = ex.length === 1 ? pick(0, H) : pick(0, H);
    const right = ex.length >= 2 ? pick(1, W) : pick(0, W);
    const bottom = ex.length >= 3 ? pick(2, H) : pick(0, H);
    const left = ex.length >= 4 ? pick(3, W) : ex.length >= 2 ? pick(1, W) : pick(0, W);
    const w = W - left - right;
    const h = H - top - bottom;
    if (w <= 0.5 || h <= 0.5) return 'hidden';
    const r = roundPart ? radii(tokenize(roundPart.split('/')[0]), W, H) : null;
    return { kind: 'rect', x: round(left), y: round(top), w: round(w), h: round(h), r: r ?? [0, 0, 0, 0] };
  }

  if (kind === 'circle' || kind === 'ellipse') {
    const [shapePart, atPart] = body.split(/\s+at\s+/i);
    const c = position(tokenize(atPart ?? 'center center'), W, H);
    if (!c) return null;
    const toks = tokenize(shapePart ?? '');
    const closestSide = Math.min(c[0], W - c[0], c[1], H - c[1]);
    const farthestSide = Math.max(c[0], W - c[0], c[1], H - c[1]);
    const radius = (t: string | undefined, total: number, axis: 'x' | 'y'): number | null => {
      if (!t || t === 'closest-side') return axis === 'x' ? Math.min(c[0], W - c[0]) : Math.min(c[1], H - c[1]);
      if (t === 'farthest-side') return axis === 'x' ? Math.max(c[0], W - c[0]) : Math.max(c[1], H - c[1]);
      return len(t, total);
    };
    let rx: number | null;
    let ry: number | null;
    if (kind === 'circle') {
      const ref = Math.sqrt((W * W + H * H) / 2);
      const t = toks[0];
      const r = !t || t === 'closest-side' ? closestSide : t === 'farthest-side' ? farthestSide : len(t, ref);
      rx = ry = r;
    } else {
      rx = radius(toks[0], W, 'x');
      ry = radius(toks[1] ?? toks[0], H, 'y');
    }
    if (rx === null || ry === null) return null;
    if (rx <= 0.5 || ry <= 0.5) return 'hidden';
    return { kind: 'ellipse', cx: round(c[0]), cy: round(c[1]), rx: round(rx), ry: round(ry) };
  }

  if (kind === 'polygon') {
    const parts = splitTopLevel(body);
    let evenodd = false;
    if (/^(nonzero|evenodd)$/i.test(parts[0])) evenodd = parts.shift()!.toLowerCase() === 'evenodd';
    const pts: [number, number][] = [];
    for (const p of parts) {
      const [xs, ys] = tokenize(p);
      const x = len(xs ?? '', W);
      const y = len(ys ?? '', H);
      if (x === null || y === null) return null;
      pts.push([round(x), round(y)]);
    }
    if (pts.length < 3) return 'hidden';
    // shoelace area: a fully collapsed polygon (reveal animations start there) shows nothing
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    if (Math.abs(a / 2) < 1) return 'hidden';
    return { kind: 'poly', pts, evenodd };
  }

  // path('M …') / path(evenodd, 'M …')
  const dm = /(['"])([\s\S]*?)\1/.exec(body);
  if (!dm) return null;
  return { kind: 'path', d: dm[2], evenodd: /^\s*evenodd/i.test(body) };
}

/** `mask-image: linear-gradient(...)` → an alpha mask paint covering the element (first layer only). */
export function readMask(cs: CSSStyleDeclaration, W: number, H: number, ctx: Ctx): Paint | null {
  const img = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  if (!img || img === 'none') return null;
  const layer = splitTopLevel(img)[0];
  const p = parseGradient(layer, { w: W, h: H }, ctx.resolveColor);
  return p && (p.type === 'linear' || p.type === 'radial') ? p : null;
}
