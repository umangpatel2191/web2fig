import { toHex } from '../../../shared/css';
import type { Asset, GradientStop, Paint as CapturedPaint, RGBA, Shadow } from '../../../shared/schema';

export interface PaintEnv {
  assets: Record<string, Asset>;
  imageHashes: Map<string, string | null>;
  tokens: Map<string, Variable>;
  useImages: boolean;
  stats: { images: number; imagesFailed: number };
}

const rgb = (c: RGBA): RGB => ({ r: c.r, g: c.g, b: c.b });
const rgba = (c: RGBA): RGBA => ({ r: c.r, g: c.g, b: c.b, a: c.a });

export function solid(c: RGBA, env?: PaintEnv): SolidPaint {
  const paint: SolidPaint = { type: 'SOLID', color: rgb(c), opacity: c.a };
  const v = env && c.a >= 0.99 ? env.tokens.get(toHex(c)) : undefined;
  if (v) {
    try {
      return figma.variables.setBoundVariableForPaint(paint, 'color', v);
    } catch {
      /* binding is best-effort */
    }
  }
  return paint;
}

const stops = (s: GradientStop[]): ColorStop[] => s.map((x) => ({ position: x.pos, color: rgba(x.color) }));

/** CSS angle → Figma gradient transform (node-normalised space → gradient space). */
export function linearTransform(angle: number, w: number, h: number): Transform {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
  const Dx = dx * L;
  const Dy = dy * L;
  const Sx = w / 2 - Dx / 2;
  const Sy = h / 2 - Dy / 2;
  const L2 = L * L;
  return [
    [(Dx * w) / L2, (Dy * h) / L2, (-Sx * Dx - Sy * Dy) / L2],
    [(-Dy * w) / L2, (Dx * h) / L2, (Sx * Dy - Sy * Dx) / L2 + 0.5],
  ];
}

export function radialTransform(cx: number, cy: number, rx: number, ry: number, w: number, h: number): Transform {
  const nx = rx / (w || 1);
  const ny = ry / (h || 1);
  const ncx = cx / (w || 1);
  const ncy = cy / (h || 1);
  return [
    [1 / (2 * nx), 0, 0.5 - ncx / (2 * nx)],
    [0, 1 / (2 * ny), 0.5 - ncy / (2 * ny)],
  ];
}

function imageHash(assetId: string, env: PaintEnv): string | null {
  if (env.imageHashes.has(assetId)) return env.imageHashes.get(assetId) ?? null;
  const asset = env.assets[assetId];
  let hash: string | null = null;
  if (asset && asset.kind === 'raster') {
    try {
      hash = figma.createImage(figma.base64Decode(asset.data)).hash;
      env.stats.images++;
    } catch {
      env.stats.imagesFailed++;
    }
  } else {
    env.stats.imagesFailed++;
  }
  env.imageHashes.set(assetId, hash);
  return hash;
}

/** Converts a captured paint to a Figma paint. SVG image paints are handled by the builder. */
export function toFigmaPaint(p: CapturedPaint, w: number, h: number, env: PaintEnv): Paint | null {
  switch (p.type) {
    case 'solid':
      return p.color.a > 0 ? solid(p.color, env) : null;
    case 'linear':
      return { type: 'GRADIENT_LINEAR', gradientStops: stops(p.stops), gradientTransform: linearTransform(p.angle, w, h) };
    case 'radial':
      return { type: 'GRADIENT_RADIAL', gradientStops: stops(p.stops), gradientTransform: radialTransform(p.cx, p.cy, p.rx, p.ry, w, h) };
    case 'image': {
      if (!env.useImages) return null;
      const asset = env.assets[p.asset];
      if (!asset || asset.kind !== 'raster') return null;
      const hash = imageHash(p.asset, env);
      if (!hash) return null;
      if (p.fit === 'tile') {
        const nat = asset.w || 1;
        return { type: 'IMAGE', imageHash: hash, scaleMode: 'TILE', scalingFactor: p.tile ? p.tile.w / nat : 1 };
      }
      if (p.fit === 'stretch') {
        return { type: 'IMAGE', imageHash: hash, scaleMode: 'CROP', imageTransform: [[1, 0, 0], [0, 1, 0]] };
      }
      if (p.fit === 'fill' && p.pos && asset.w > 0 && asset.h > 0 && w > 0 && h > 0) {
        // object-position / background-position on a cover image: crop with an explicit transform.
        const s = Math.max(w / asset.w, h / asset.h);
        const dw = asset.w * s;
        const dh = asset.h * s;
        const ox = (w - dw) * p.pos[0];
        const oy = (h - dh) * p.pos[1];
        return { type: 'IMAGE', imageHash: hash, scaleMode: 'CROP', imageTransform: [[w / dw, 0, -ox / dw], [0, h / dh, -oy / dh]] };
      }
      return { type: 'IMAGE', imageHash: hash, scaleMode: p.fit === 'fit' ? 'FIT' : 'FILL' };
    }
  }
}

export function toEffects(shadows: Shadow[] | undefined, opts: { blur?: number; bgBlur?: number; textOnly?: boolean } = {}): Effect[] {
  const out: Effect[] = [];
  for (const s of shadows ?? []) {
    if (opts.textOnly && s.inset) continue;
    out.push({
      type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: rgba(s.color),
      offset: { x: s.x, y: s.y },
      radius: s.blur,
      spread: s.spread,
      visible: true,
      blendMode: 'NORMAL',
    } as Effect);
  }
  // Figma's blur radius is roughly 2× the CSS blur() value.
  if (opts.blur) out.push({ type: 'LAYER_BLUR', radius: opts.blur * 2, visible: true } as Effect);
  if (opts.bgBlur) out.push({ type: 'BACKGROUND_BLUR', radius: opts.bgBlur * 2, visible: true } as Effect);
  return out;
}
