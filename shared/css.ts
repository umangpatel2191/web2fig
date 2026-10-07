/**
 * Pure CSS value parsers. No DOM access, so they are unit-testable in Node.
 * Anything exotic (lab(), oklch(), named colors…) is delegated to an optional resolver
 * that the browser-side code backs with a canvas.
 */
import type { GradientStop, Paint, RGBA, Shadow } from './schema';

export type ColorResolver = (css: string) => RGBA | null;

export const round = (n: number, p = 2): number => {
  const f = 10 ** p;
  return Math.round(n * f) / f;
};

/** Split on `sep` while ignoring separators inside parentheses or quotes. */
export function splitTopLevel(input: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split on whitespace at paren depth 0. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function parseChannel(tok: string, scale: number): number {
  if (tok.endsWith('%')) return clamp01(parseFloat(tok) / 100);
  return clamp01(parseFloat(tok) / scale);
}

function parseAlpha(tok: string): number {
  const t = tok.trim();
  if (t.endsWith('%')) return clamp01(parseFloat(t) / 100);
  const n = parseFloat(t);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

export function parseColor(input: string, resolve?: ColorResolver): RGBA | null {
  const s = input.trim().toLowerCase();
  if (!s || s === 'none') return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = /^(rgba?|color)\((.*)\)$/s.exec(s);
  if (fn) {
    const [mainPart, slashPart] = fn[2].split('/');
    let alpha = slashPart !== undefined ? parseAlpha(slashPart) : 1;
    let parts = mainPart.replace(/,/g, ' ').trim().split(/\s+/);
    if (fn[1] === 'color') {
      if (parts[0] !== 'srgb') return resolve ? resolve(s) : null;
      parts = parts.slice(1);
      if (parts.length < 3) return null;
      return {
        r: parseChannel(parts[0], 1),
        g: parseChannel(parts[1], 1),
        b: parseChannel(parts[2], 1),
        a: alpha,
      };
    }
    if (parts.length < 3) return null;
    if (parts.length >= 4) alpha = parseAlpha(parts[3]);
    return {
      r: parseChannel(parts[0], 255),
      g: parseChannel(parts[1], 255),
      b: parseChannel(parts[2], 255),
      a: alpha,
    };
  }

  return resolve ? resolve(s) : null;
}

export function parseLength(tok: string): number | null {
  const m = /^(-?[\d.]+)(px)?$/.exec(tok.trim());
  return m ? parseFloat(m[1]) : null;
}

/** Parses box-shadow / text-shadow lists. */
export function parseShadows(value: string, resolve?: ColorResolver): Shadow[] {
  if (!value || value === 'none') return [];
  const out: Shadow[] = [];
  for (const layer of splitTopLevel(value)) {
    let inset = false;
    let color: RGBA | null = null;
    const nums: number[] = [];
    for (const t of tokenize(layer)) {
      if (t === 'inset') inset = true;
      else {
        const n = parseLength(t);
        if (n !== null) nums.push(n);
        else {
          const c = parseColor(t, resolve);
          if (c) color = c;
        }
      }
    }
    if (nums.length < 2) continue;
    out.push({
      inset,
      x: nums[0],
      y: nums[1],
      blur: Math.max(0, nums[2] ?? 0),
      spread: nums[3] ?? 0,
      color: color ?? { r: 0, g: 0, b: 0, a: 1 },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Gradients                                                           */
/* ------------------------------------------------------------------ */

interface RawStop {
  color: RGBA;
  pos: number | null; // in `unit`
  unit: '%' | 'px' | null;
}

function parseAngle(tok: string): number | null {
  const m = /^(-?[\d.]+)(deg|grad|rad|turn)?$/.exec(tok.trim());
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case 'grad':
      return (v * 360) / 400;
    case 'rad':
      return (v * 180) / Math.PI;
    case 'turn':
      return v * 360;
    default:
      return v;
  }
}

function directionToAngle(dir: string, w: number, h: number): number | null {
  const words = dir.replace(/^to\s+/, '').trim().split(/\s+/);
  const has = (k: string) => words.includes(k);
  const dx = has('right') ? 1 : has('left') ? -1 : 0;
  const dy = has('bottom') ? 1 : has('top') ? -1 : 0;
  if (!dx && !dy) return null;
  if (dx && dy) {
    // "magic corners": the 50% line passes through the two other corners.
    const vx = dx * h;
    const vy = dy * w;
    return (Math.atan2(vx, -vy) * 180) / Math.PI;
  }
  return dy === -1 ? 0 : dx === 1 ? 90 : dy === 1 ? 180 : 270;
}

function parseRawStops(args: string[], resolve?: ColorResolver): RawStop[] {
  const stops: RawStop[] = [];
  for (const arg of args) {
    const toks = tokenize(arg);
    let color: RGBA | null = null;
    const positions: { v: number; unit: '%' | 'px' }[] = [];
    for (const t of toks) {
      const parsed: RGBA | null = color ? null : parseColor(t, resolve);
      if (parsed) {
        color = parsed;
        continue;
      }
      const m = /^(-?[\d.]+)(%|px)?$/.exec(t);
      if (m) positions.push({ v: parseFloat(m[1]), unit: m[2] === '%' ? '%' : 'px' });
    }
    if (!color) continue; // colour hint – ignored
    if (positions.length === 0) stops.push({ color, pos: null, unit: null });
    for (const p of positions.slice(0, 2)) stops.push({ color, pos: p.v, unit: p.unit });
  }
  return stops;
}

function finalizeStops(raw: RawStop[], length: number): GradientStop[] {
  if (raw.length < 2) return [];
  const pos: (number | null)[] = raw.map((s) =>
    s.pos === null ? null : s.unit === '%' ? s.pos / 100 : length > 0 ? s.pos / length : 0,
  );
  if (pos[0] === null) pos[0] = 0;
  if (pos[pos.length - 1] === null) pos[pos.length - 1] = 1;
  let i = 0;
  while (i < pos.length) {
    if (pos[i] !== null) {
      i++;
      continue;
    }
    const start = i - 1;
    let end = i;
    while (pos[end] === null) end++;
    const a = pos[start] as number;
    const b = pos[end] as number;
    for (let k = start + 1; k < end; k++) pos[k] = a + ((b - a) * (k - start)) / (end - start);
    i = end;
  }
  let prev = 0;
  const stops: GradientStop[] = raw.map((s, idx) => {
    const p = Math.max(prev, clamp01(pos[idx] as number));
    prev = p;
    return { pos: p, color: { ...s.color } };
  });
  // CSS interpolates in premultiplied space; Figma doesn't. Borrow the neighbour's RGB for
  // fully transparent stops so fades don't turn grey.
  stops.forEach((s, idx) => {
    if (s.color.a > 0) return;
    const before = idx > 0 ? stops[idx - 1] : undefined;
    const after = idx < stops.length - 1 ? stops[idx + 1] : undefined;
    const ref = before && before.color.a > 0 ? before : after && after.color.a > 0 ? after : null;
    if (ref) s.color = { r: ref.color.r, g: ref.color.g, b: ref.color.b, a: 0 };
  });
  return stops;
}

function coord(tok: string, size: number): number {
  if (tok === 'left' || tok === 'top') return 0;
  if (tok === 'center') return size / 2;
  if (tok === 'right' || tok === 'bottom') return size;
  if (tok.endsWith('%')) return (parseFloat(tok) / 100) * size;
  const n = parseLength(tok);
  return n ?? size / 2;
}

function resolvePosition(tokens: string[], w: number, h: number): { x: number; y: number } {
  if (tokens.length === 0) return { x: w / 2, y: h / 2 };
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t === 'top' || t === 'bottom') return { x: w / 2, y: coord(t, h) };
    return { x: coord(t, w), y: h / 2 };
  }
  let [a, b] = tokens;
  if (a === 'top' || a === 'bottom' || b === 'left' || b === 'right') [a, b] = [b, a];
  return { x: coord(a, w), y: coord(b, h) };
}

/** Parses one `linear-gradient()` / `radial-gradient()` layer. Repeating gradients are not supported. */
export function parseGradient(
  layer: string,
  box: { w: number; h: number },
  resolve?: ColorResolver,
): Paint | null {
  const m = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/s.exec(layer.trim());
  if (!m || m[1]) return null;
  const kind = m[2];
  const args = splitTopLevel(m[3]);
  if (args.length < 2) return null;
  const { w, h } = box;

  const first = args[0].replace(/\s+in\s+[a-z0-9 -]+$/i, '').trim();
  const firstIsColor = tokenize(first).some((t) => parseColor(t, resolve));

  if (kind === 'linear') {
    let angle = 180;
    let rest = args;
    if (!firstIsColor || /^to\s/.test(first)) {
      const a = /^to\s/.test(first) ? directionToAngle(first, w, h) : parseAngle(first);
      if (a !== null) angle = a;
      rest = args.slice(1);
    }
    const rad = (angle * Math.PI) / 180;
    const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const stops = finalizeStops(parseRawStops(rest, resolve), length);
    return stops.length >= 2 ? { type: 'linear', angle, stops } : null;
  }

  // radial
  let rest = args;
  let cx = w / 2;
  let cy = h / 2;
  let rx = 0;
  let ry = 0;
  let sizeKw = 'farthest-corner';
  let circle = false;
  let explicit: number[] = [];
  if (!firstIsColor) {
    rest = args.slice(1);
    const [shapePart, posPart] = first.split(/\s+at\s+/);
    for (const t of tokenize(shapePart ?? '')) {
      if (t === 'circle') circle = true;
      else if (t === 'ellipse') circle = false;
      else if (/^(closest|farthest)-(side|corner)$/.test(t)) sizeKw = t;
      else {
        const n = t.endsWith('%') ? (parseFloat(t) / 100) * w : parseLength(t);
        if (n !== null) explicit.push(n);
      }
    }
    if (posPart) {
      const p = resolvePosition(tokenize(posPart), w, h);
      cx = p.x;
      cy = p.y;
    }
    if (explicit.length === 1) circle = true;
  }
  const dl = cx;
  const dr = w - cx;
  const dt = cy;
  const db = h - cy;
  if (explicit.length >= 2) {
    rx = explicit[0];
    ry = explicit[1];
  } else if (explicit.length === 1) {
    rx = ry = explicit[0];
  } else if (circle) {
    const corners = [Math.hypot(dl, dt), Math.hypot(dr, dt), Math.hypot(dl, db), Math.hypot(dr, db)];
    const sides = [dl, dr, dt, db];
    const r =
      sizeKw === 'closest-side'
        ? Math.min(...sides)
        : sizeKw === 'farthest-side'
          ? Math.max(...sides)
          : sizeKw === 'closest-corner'
            ? Math.min(...corners)
            : Math.max(...corners);
    rx = ry = r;
  } else {
    const nx = Math.min(dl, dr);
    const ny = Math.min(dt, db);
    const fx = Math.max(dl, dr);
    const fy = Math.max(dt, db);
    const k = Math.SQRT2;
    if (sizeKw === 'closest-side') [rx, ry] = [nx, ny];
    else if (sizeKw === 'farthest-side') [rx, ry] = [fx, fy];
    else if (sizeKw === 'closest-corner') [rx, ry] = [nx * k, ny * k];
    else [rx, ry] = [fx * k, fy * k];
  }
  if (!(rx > 0) || !(ry > 0)) return null;
  const stops = finalizeStops(parseRawStops(rest, resolve), rx);
  return stops.length >= 2 ? { type: 'radial', cx, cy, rx, ry, stops } : null;
}

/** One corner of `border-radius`, e.g. "10px", "50%", "10px 20px". Figma only has circular radii. */
export function parseRadius(value: string, w: number, h: number): number {
  const toks = tokenize(value);
  if (toks.length === 0) return 0;
  const conv = (t: string, size: number) => (t.endsWith('%') ? (parseFloat(t) / 100) * size : parseFloat(t) || 0);
  const rx = conv(toks[0], w);
  const ry = toks[1] ? conv(toks[1], h) : toks[0].endsWith('%') ? conv(toks[0], h) : rx;
  return Math.max(0, Math.min(rx, ry));
}

export function toHex(c: RGBA): string {
  const h = (n: number) =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
