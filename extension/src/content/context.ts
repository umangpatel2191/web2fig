import type { CaptureOptions } from '../../../shared/messages';
import type { ColorResolver } from '../../../shared/css';
import { parseColor } from '../../../shared/css';
import type { FontUsage, Paint, RGBA } from '../../../shared/schema';
import type { AssetCollector } from './assets';

export interface Origin {
  x: number;
  y: number;
  /** Size of the frame at this origin (used to detect children that overflow it). */
  w?: number;
  h?: number;
  /** Some ancestor carries a CSS transform: layout positions no longer equal on-page positions, so don't cull by page bounds. */
  t?: boolean;
}

export interface Ctx {
  /** Added to client coordinates to get capture-space coordinates. */
  originX: number;
  originY: number;
  bounds: { w: number; h: number };
  opts: CaptureOptions;
  assets: AssetCollector;
  fonts: Map<string, { weights: Set<number>; italic: boolean; count: number }>;
  warnings: Map<string, number>;
  count: number;
  maxNodes: number;
  truncated: boolean;
  resolveColor: ColorResolver;
  /** Fallback text colour when an ancestor uses `background-clip: text`. */
  gradientText: RGBA | null;
  /** The gradient itself (same scope as `gradientText`). */
  gradientPaint: Paint | null;
  /** Paint-order counter (pre-order index of every element/text emitted). */
  order: number;
  /** Own CSS transform of elements, recorded before transforms were switched off for measuring. */
  xf: WeakMap<Element, ElementTransform>;
  /** Pseudo-element transforms keyed by originating element. */
  pxf: WeakMap<Element, { before?: ElementTransform; after?: ElementTransform }>;
  /** Screenshot-backed content (cross-origin iframes, tainted canvases/videos): element → asset id. */
  shots: WeakMap<Element, string>;
  depth: number;
  /** SVG assets used as repeating backgrounds: rasterised once so Figma can tile them natively. */
  rasterSvgs: Set<string>;
  /** Async work to finish after downloads and before `deferred` (rasterising tiles). */
  jobs: (() => Promise<void>)[];
  stats: { texts: number; images: number; svgs: number };
  /** Work that needs asset dimensions, run after downloads finish. */
  deferred: (() => void)[];
}

/** matrix = [a,b,c,d,e,f] of the composed CSS transform, origin = transform-origin in px (relative to the border box). */
export interface ElementTransform {
  m: [number, number, number, number, number, number];
  ox: number;
  oy: number;
}

export function warn(ctx: Ctx, message: string, n = 1): void {
  ctx.warnings.set(message, (ctx.warnings.get(message) ?? 0) + n);
}

export function color(ctx: Ctx, css: string): RGBA | null {
  return parseColor(css, ctx.resolveColor);
}

/** Canvas-backed resolver for colour syntaxes we don't parse ourselves (oklch, lab, named…). */
export function makeColorResolver(): ColorResolver {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  return (css) => {
    if (!g) return null;
    try {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = '#010203';
      g.fillStyle = css;
      if (g.fillStyle === '#010203' && css.replace(/\s/g, '') !== '#010203') return null;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
    } catch {
      return null;
    }
  };
}

export function fontUsageList(ctx: Ctx): FontUsage[] {
  return [...ctx.fonts.entries()]
    .map(([family, u]) => ({ family, weights: [...u.weights].sort((a, b) => a - b), italic: u.italic, count: u.count }))
    .sort((a, b) => b.count - a.count);
}

export function warningList(ctx: Ctx): string[] {
  return [...ctx.warnings.entries()].map(([m, n]) => (n > 1 ? `${n}× ${m}` : m));
}
