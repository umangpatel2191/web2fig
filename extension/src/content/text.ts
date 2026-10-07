import { parseShadows, round } from '../../../shared/css';
import type { FontSpec, FrameNode, RGBA, TextLayer } from '../../../shared/schema';
import { color, warn, type Ctx, type Origin } from './context';

export interface Line {
  /** Right edge of every code point (only kept by the scanner, used to truncate with an ellipsis). */
  rights?: number[];
  text: string;
  left: number;
  right: number;
  top: number;
  height: number;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont']);

function codepoints(s: string): { ch: string; i: number }[] {
  const out: { ch: string; i: number }[] = [];
  let i = 0;
  for (const ch of s) {
    out.push({ ch, i });
    i += ch.length;
  }
  return out;
}

export function readFont(cs: CSSStyleDeclaration, lineHeight: number): FontSpec {
  const families = cs.fontFamily
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const ls = parseFloat(cs.letterSpacing);
  const decoration = cs.textDecorationLine.includes('underline')
    ? 'underline'
    : cs.textDecorationLine.includes('line-through')
      ? 'line-through'
      : 'none';
  const dir = cs.direction;
  const ta = cs.textAlign;
  const align: FontSpec['align'] =
    ta === 'center'
      ? 'center'
      : ta === 'right' || (ta === 'end' && dir !== 'rtl') || (ta === 'start' && dir === 'rtl')
        ? 'right'
        : 'left';
  return {
    families,
    size: round(parseFloat(cs.fontSize) || 16),
    weight: parseInt(cs.fontWeight, 10) || 400,
    italic: /italic|oblique/.test(cs.fontStyle),
    lineHeight: round(lineHeight),
    letterSpacing: Number.isFinite(ls) ? round(ls) : 0,
    align,
    decoration,
  };
}

export function trackFont(ctx: Ctx, font: FontSpec): void {
  const family = font.families.find((f) => !GENERIC.has(f.toLowerCase())) ?? font.families[0] ?? 'sans-serif';
  const u = ctx.fonts.get(family) ?? { weights: new Set<number>(), italic: false, count: 0 };
  u.weights.add(font.weight);
  u.italic ||= font.italic;
  u.count++;
  ctx.fonts.set(family, u);
}

function applyTransform(text: string, tt: string): string {
  switch (tt) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/(^|[\s\-"'(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
    default:
      return text;
  }
}

function fillColor(cs: CSSStyleDeclaration, ctx: Ctx): RGBA {
  const fill = color(ctx, cs.getPropertyValue('-webkit-text-fill-color'));
  if (fill && fill.a > 0) return fill;
  if (fill && fill.a === 0 && ctx.gradientText) return ctx.gradientText;
  return color(ctx, cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
}

function charWidth(range: Range, node: Text, i: number): number {
  range.setStart(node, i);
  range.setEnd(node, i + 1);
  return range.getBoundingClientRect().width;
}

/** Walks a text node character by character to recover the browser's exact line breaks. */
function scanLines(node: Text, range: Range, keepNewlines: boolean, keepSpaces: boolean): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const { ch, i } of codepoints(node.data)) {
    if (ch === '\n' && keepNewlines) {
      cur = null;
      continue;
    }
    range.setStart(node, i);
    range.setEnd(node, i + ch.length);
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const isSpace = /\s/.test(ch);
    if (isSpace && r.width <= 0.01 && !keepSpaces) continue; // collapsed whitespace
    if (!cur || r.top > cur.top + Math.max(2, cur.height * 0.5)) {
      if (isSpace && !cur) {
        // leading whitespace on a fresh line is collapsed away by the browser
        if (!keepSpaces) continue;
      }
      cur = { text: '', left: r.left, right: r.right, top: r.top, height: r.height };
      lines.push(cur);
    }
    cur.text += ch;
    (cur.rights ??= []).push(r.right);
    cur.left = Math.min(cur.left, r.left);
    cur.right = Math.max(cur.right, r.right);
  }
  for (const l of lines) if (!keepSpaces) l.text = l.text.replace(/\s+$/, '');
  return lines.filter((l) => l.text.length > 0);
}

export function textLayers(node: Text, ctx: Ctx, origin: Origin): (TextLayer | FrameNode)[] {
  const el = node.parentElement;
  if (!el || !node.data) return [];
  const cs = getComputedStyle(el);
  if (cs.visibility !== 'visible') return [];
  const ws = cs.whiteSpace;
  const keepSpaces = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
  const keepNewlines = keepSpaces || ws === 'pre-line';
  if (!/\S/.test(node.data)) return [];
  if (cs.writingMode && cs.writingMode !== 'horizontal-tb') {
    warn(ctx, 'vertical text is not supported');
    return [];
  }

  const ellipsisOwner = findEllipsisOwner(el);
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return [];

  let lines: Line[];
  if (rects.length === 1 && !keepNewlines && !ellipsisOwner) {
    let s = node.data.replace(/[ \t\r\n\f]+/g, ' ');
    if (s.startsWith(' ') && charWidth(range, node, 0) <= 0.01) s = s.slice(1);
    if (s.endsWith(' ') && s.length > 0 && charWidth(range, node, node.data.length - 1) <= 0.01) s = s.slice(0, -1);
    if (!s) return [];
    const r = rects[0];
    lines = [{ text: s, left: r.left, right: r.right, top: r.top, height: r.height }];
  } else {
    lines = scanLines(node, range, keepNewlines, keepSpaces);
  }
  if (lines.length === 0) return [];

  const lhCss = parseFloat(cs.lineHeight);
  const lineHeight = Number.isFinite(lhCss)
    ? lhCss
    : lines.length > 1
      ? Math.abs(lines[1].top - lines[0].top) || lines[0].height
      : lines[0].height;

  lines = truncateLines(lines, ellipsisOwner, cs);
  if (lines.length === 0) return [];

  // Drop lines that sit outside the page (text-indent: -9999px, off-canvas menus, …).
  if (!origin.t) lines = lines.filter((l) => !(l.right + ctx.originX < -2 || l.left + ctx.originX > ctx.bounds.w + 2 || l.top + l.height + ctx.originY < -2 || l.top + ctx.originY > ctx.bounds.h + 2));
  if (lines.length === 0) return [];

  const font = readFont(cs, lineHeight);
  const fill = fillColor(cs, ctx);
  const stroke = strokeOf(cs, ctx);
  if (fill.a === 0 && !stroke) return []; // invisible (transparent text, no gradient fallback, no outline)
  const rawFill = color(ctx, cs.getPropertyValue('-webkit-text-fill-color'));
  const gradient = rawFill && rawFill.a === 0 && ctx.gradientPaint?.type === 'linear' ? ctx.gradientPaint : undefined;

  // Icon fonts (Font Awesome, Material Icons, …) have no Figma equivalent → draw the glyphs as an image.
  if (ctx.opts.images && isIconFont(font, node.data)) {
    const icon = rasterizeGlyphs(lines, cs, fill, ctx, origin);
    if (icon.length) return icon;
  }

  trackFont(ctx, font);
  const shadows = parseShadows(cs.textShadow, ctx.resolveColor).filter((s) => !s.inset);
  const mk = (group: Line[]): TextLayer => {
    const text = applyTransform(group.map((l) => l.text).join('\n'), cs.textTransform).replace(/[­​]/g, '');
    const left = Math.min(...group.map((l) => l.left));
    const right = Math.max(...group.map((l) => l.right));
    const first = group[0];
    const top = first.top + first.height / 2 - lineHeight / 2;
    ctx.stats.texts++;
    ctx.count++;
    return {
      type: 'text',
      name: text.slice(0, 40),
      x: round(left + ctx.originX - origin.x),
      y: round(top + ctx.originY - origin.y),
      w: round(right - left),
      h: round(lineHeight * group.length),
      text,
      font,
      color: fill,
      paint: gradient,
      href: linkOf(el),
      stroke,
      shadows: shadows.length ? shadows : undefined,
    };
  };
  return groupLines(lines, font.align).map(mk);
}

/** Absolute URL of the enclosing link (http, https, mailto, tel only). */
function linkOf(el: Element): string | undefined {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return undefined;
  const raw = a.getAttribute('href') ?? '';
  if (!raw || raw === '#' || /^javascript:/i.test(raw)) return undefined;
  const href = a.href;
  return /^(https?:|mailto:|tel:)/i.test(href) ? href.slice(0, 2000) : undefined;
}

function strokeOf(cs: CSSStyleDeclaration, ctx: Ctx): TextLayer['stroke'] {
  const w = parseFloat(cs.getPropertyValue('-webkit-text-stroke-width'));
  if (!(w > 0)) return undefined;
  const c = color(ctx, cs.getPropertyValue('-webkit-text-stroke-color'));
  return c && c.a > 0 ? { w: round(w), color: c } : undefined;
}

interface Truncation {
  owner: Element;
  /** `line-clamp` (visible block height) or `ellipsis` (single line, clipped width). */
  kind: 'clamp' | 'ellipsis';
}

/** The block that truncates this text: `-webkit-line-clamp` or `text-overflow: ellipsis` with clipping overflow. */
function findEllipsisOwner(el: Element): Truncation | null {
  for (let p: Element | null = el, depth = 0; p && depth < 8; p = p.parentElement, depth++) {
    const cs = getComputedStyle(p);
    const clamp = parseInt(cs.getPropertyValue('-webkit-line-clamp'), 10);
    if (Number.isFinite(clamp) && clamp > 0 && cs.overflowY !== 'visible') return { owner: p, kind: 'clamp' };
    if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible' && p.scrollWidth > p.clientWidth + 1) return { owner: p, kind: 'ellipsis' };
    if (cs.display !== 'inline' && cs.display !== 'contents') break;
  }
  return null;
}

/** Re-creates the "…" the browser draws when it truncates text (it isn't in the DOM). */
function truncateLines(lines: Line[], t: Truncation | null, cs: CSSStyleDeclaration): Line[] {
  if (!t) return lines;
  const r = t.owner.getBoundingClientRect();
  const ocs = getComputedStyle(t.owner);
  if (t.kind === 'clamp') {
    const bottom = r.bottom - parseFloat(ocs.paddingBottom || '0') - parseFloat(ocs.borderBottomWidth || '0');
    const kept = lines.filter((l) => l.top + l.height / 2 <= bottom);
    if (kept.length === lines.length || kept.length === 0) return lines;
    const last = { ...kept[kept.length - 1] };
    last.text = last.text.replace(/[\s.,;:!?-]+$/, '') + '…';
    kept[kept.length - 1] = last;
    return kept;
  }
  const maxRight = r.right - parseFloat(ocs.paddingRight || '0') - parseFloat(ocs.borderRightWidth || '0');
  const ell = (parseFloat(cs.fontSize) || 16) * 0.85;
  return lines.map((l) => {
    if (l.right <= maxRight + 0.5 || !l.rights) return l;
    const chars = Array.from(l.text);
    let k = -1;
    for (let i = 0; i < chars.length; i++) if ((l.rights[i] ?? Infinity) <= maxRight - ell) k = i;
    if (k < 0) return l;
    return { ...l, text: chars.slice(0, k + 1).join('').replace(/\s+$/, '') + '…', right: Math.min(l.right, maxRight) };
  });
}

/**
 * Lines of one text node usually share an edge (left for left-aligned text, centre for centred…) and can be
 * one multi-line Figma text. When they don't — an inline run that starts mid-line after a sibling
 * ("Heading sentence. <span>Continues here…</span>"), `text-indent`, float-wrapped text — keeping them
 * together would draw the first line at the wrong x. Those lines are split into separate layers.
 */
export function groupLines<T extends { left: number; right: number }>(lines: T[], align: FontSpec['align']): T[][] {
  const tol = 1.5;
  const edge = (l: T) => (align === 'center' ? (l.left + l.right) / 2 : align === 'right' ? l.right : l.left);
  const groups: T[][] = [];
  for (const l of lines) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(edge(g[g.length - 1]) - edge(l)) <= tol) g.push(l);
    else groups.push([l]);
  }
  return groups;
}

const ICON_FAMILY = /(^|\b)(font ?awesome|fa[srlbd]?|material( icons| symbols)[\w ]*|icon[\w -]*|glyphicons?[\w -]*|ionicons|feather|fontello|bootstrap-icons|remixicon|lucide|boxicons|themify|simple-line-icons|linearicons|eicons|dashicons|typicons|octicons|elusive|entypo|weathericons)(\b|$)/i;
const PRIVATE_USE = /[-]/;

export function isIconFont(font: FontSpec, data: string): boolean {
  if (PRIVATE_USE.test(data)) return true;
  return font.families.some((f) => ICON_FAMILY.test(f));
}

/** Draws text with the page's own (already loaded) font into a PNG so icon fonts survive the trip to Figma. */
export function rasterizeGlyphs(lines: Line[], cs: CSSStyleDeclaration, fill: RGBA, ctx: Ctx, origin: Origin): FrameNode[] {
  const out: FrameNode[] = [];
  const scale = 3;
  for (const l of lines) {
    const w = Math.max(1, Math.ceil(l.right - l.left));
    const h = Math.max(1, Math.ceil(l.height));
    if (w * h * scale * scale > 4_000_000) continue;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(h * scale);
    const g = c.getContext('2d');
    if (!g) continue;
    g.scale(scale, scale);
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    g.textBaseline = 'middle';
    g.fillStyle = `rgba(${Math.round(fill.r * 255)},${Math.round(fill.g * 255)},${Math.round(fill.b * 255)},${fill.a})`;
    g.fillText(l.text, 0, h / 2);
    let url: string;
    try {
      url = c.toDataURL('image/png');
    } catch {
      continue;
    }
    const asset = ctx.assets.addInline({ kind: 'raster', mime: 'image/png', data: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height });
    ctx.count++;
    ctx.stats.images++;
    out.push({
      type: 'frame',
      name: `icon: ${l.text.slice(0, 24)}`,
      x: round(l.left + ctx.originX - origin.x),
      y: round(l.top + ctx.originY - origin.y),
      w,
      h,
      fills: [{ type: 'image', asset, fit: 'stretch' }],
      children: [],
    });
  }
  return out;
}

/** Builds a text layer from explicit geometry (form controls, list markers, pseudo-elements). */
export function syntheticText(
  text: string,
  cs: CSSStyleDeclaration,
  box: { x: number; y: number; w: number },
  ctx: Ctx,
  opts: { color?: RGBA; align?: FontSpec['align']; lineHeight?: number } = {},
): TextLayer {
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lhCss = parseFloat(cs.lineHeight);
  const lineHeight = opts.lineHeight ?? (Number.isFinite(lhCss) ? lhCss : fontSize * 1.2);
  const font = readFont(cs, lineHeight);
  if (opts.align) font.align = opts.align;
  trackFont(ctx, font);
  const lines = text.split('\n').length;
  ctx.stats.texts++;
  ctx.count++;
  return {
    type: 'text',
    name: text.slice(0, 40),
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: round(lineHeight * lines),
    text: applyTransform(text, cs.textTransform),
    font,
    color: opts.color ?? fillColor(cs, ctx),
  };
}
