import { parseGradient, parseRadius, parseShadows, round, splitTopLevel, tokenize } from '../../../shared/css';
import type { Asset, BlendName, Corners, FrameNode, Paint, Shadow, Stroke } from '../../../shared/schema';
import { color, warn, type Ctx } from './context';

export interface BoxStyle {
  fills: Paint[];
  /** Extra frames (sized/positioned background images) that sit below the content. */
  bgFrames: FrameNode[];
  stroke?: Stroke;
  radius?: Corners;
  shadows: Shadow[];
  clip: boolean;
  blur?: number;
  bgBlur?: number;
  blend?: BlendName;
  clipText: boolean;
}

const BLEND: Record<string, BlendName> = {
  multiply: 'MULTIPLY',
  screen: 'SCREEN',
  overlay: 'OVERLAY',
  darken: 'DARKEN',
  lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

const px = (v: string) => parseFloat(v) || 0;
const pick = (list: string[], i: number, fallback: string) => (list.length ? list[i % list.length] : fallback);

export function assetSize(a: Asset | undefined): { w: number; h: number } | null {
  if (!a) return null;
  if (a.kind === 'raster') return { w: a.w, h: a.h };
  const vb = /viewBox=["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(a.svg);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  const w = /<svg[^>]*\swidth=["']([\d.]+)/i.exec(a.svg);
  const h = /<svg[^>]*\sheight=["']([\d.]+)/i.exec(a.svg);
  return w && h ? { w: parseFloat(w[1]), h: parseFloat(h[1]) } : null;
}

/** Percent positions → 0..1 fractions; undefined when centred or not expressible as percentages. */
export function fractions(x: string, y: string): [number, number] | undefined {
  if (!x.endsWith('%') || !y.endsWith('%')) return undefined;
  const fx = parseFloat(x) / 100;
  const fy = parseFloat(y) / 100;
  return Math.abs(fx - 0.5) < 0.005 && Math.abs(fy - 0.5) < 0.005 ? undefined : [fx, fy];
}

export function bgPosition(token: string, free: number): number {
  // `right 10px bottom 10px` computes to calc(100% - 10px)
  const calc = /^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)(?:px)?\s*\)$/.exec(token.trim());
  if (calc) return (parseFloat(calc[1]) / 100) * free + (calc[2] === '-' ? -1 : 1) * parseFloat(calc[3]);
  if (token.endsWith('%')) return (parseFloat(token) / 100) * free;
  const n = parseFloat(token);
  return Number.isFinite(n) ? n : free / 2;
}

type Repeat = 'repeat' | 'no-repeat' | 'space' | 'round';

function parseRepeat(token: string): [Repeat, Repeat] {
  const t = tokenize(token);
  if (t[0] === 'repeat-x') return ['repeat', 'no-repeat'];
  if (t[0] === 'repeat-y') return ['no-repeat', 'repeat'];
  const norm = (v: string | undefined): Repeat => (v === 'no-repeat' || v === 'space' || v === 'round' ? v : 'repeat');
  return [norm(t[0]), norm(t[1] ?? t[0])];
}

/** One CSS length/percentage/auto → px (null = auto). */
function sizeDim(t: string | undefined, total: number): number | null {
  if (!t || t === 'auto') return null;
  return t.endsWith('%') ? (parseFloat(t) / 100) * total : parseFloat(t);
}

const MAX_TILE_COPIES = 60;

/** CSS angle + stops → standalone SVG of size w×h (used to bake a repeating gradient tile into a PNG). */
function gradientSvg(p: Paint, w: number, h: number): string | null {
  const stops = (s: { pos: number; color: { r: number; g: number; b: number; a: number } }[]) =>
    s.map((x) => `<stop offset="${x.pos}" stop-color="rgb(${Math.round(x.color.r * 255)},${Math.round(x.color.g * 255)},${Math.round(x.color.b * 255)})" stop-opacity="${x.color.a}"/>`).join('');
  let def: string;
  if (p.type === 'linear') {
    const rad = (p.angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const L = Math.abs(w * dx) + Math.abs(h * dy);
    const x1 = w / 2 - (dx * L) / 2;
    const y1 = h / 2 - (dy * L) / 2;
    def = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x1 + dx * L}" y2="${y1 + dy * L}">${stops(p.stops)}</linearGradient>`;
  } else if (p.type === 'radial') {
    def = `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${p.cx}" cy="${p.cy}" r="${p.rx}" gradientTransform="translate(${p.cx} ${p.cy}) scale(1 ${p.ry / p.rx}) translate(${-p.cx} ${-p.cy})">${stops(p.stops)}</radialGradient>`;
  } else return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${def}</defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
}

/** A w×h box painted by one CSS background layer, wrapped as <foreignObject> so the browser rasterises it exactly. */
function cssBoxSvg(css: { layer: string; size: string; pos: string; rep: string }, w: number, h: number): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const style = `width:${w}px;height:${h}px;background-image:${css.layer};background-size:${css.size};background-position:${css.pos};background-repeat:${css.rep}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="${esc(style)}"></div></foreignObject></svg>`;
}

/** Renders SVG markup to a PNG (browser-side). Resolves null when the image can't be decoded. */
export async function svgToPng(svg: string, w: number, h: number, scale: number): Promise<{ data: string; w: number; h: number } | null> {
  const pw = Math.max(1, Math.min(2048, Math.round(w * scale)));
  const ph = Math.max(1, Math.min(2048, Math.round(h * scale)));
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    c.getContext('2d')?.drawImage(img, 0, 0, pw, ph);
    const url = c.toDataURL('image/png');
    return { data: url.slice(url.indexOf(',') + 1), w: pw, h: ph };
  } catch {
    return null;
  }
}

/** Rewrites the root <svg> so it has an explicit pixel size (needed to rasterise viewBox-only files). */
export function sizedSvg(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs.replace(/\s(?:width|height)=["'][^"']*["']/gi, '');
    if (!/\sxmlns=/i.test(a)) a += ' xmlns="http://www.w3.org/2000/svg"';
    if (!/\sviewBox=/i.test(a)) a += ` viewBox="0 0 ${w} ${h}"`;
    return `<svg${a} width="${w}" height="${h}">`;
  });
}

/**
 * Lays out one sized / positioned / repeated background layer as frames inside a padding-box clip frame.
 * Rasters use Figma's TILE paint (one frame); vectors and gradients are copied tile by tile.
 */
function layoutTiles(
  name: string,
  fill: Paint,
  tw: number,
  th: number,
  posX: string,
  posY: string,
  repeat: [Repeat, Repeat],
  box: { x: number; y: number; w: number; h: number },
  ctx: Ctx,
  asRaster: boolean,
): FrameNode {
  let [rx, ry] = repeat;
  if (!(tw > 0.5) || !(th > 0.5) || !Number.isFinite(tw + th)) {
    // `background-size: 0px auto` and friends: the image is intentionally invisible
    return { type: 'frame', name, x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), clip: true, children: [] };
  }
  // round: shrink/stretch the tile so a whole number fits.
  if (rx === 'round' && tw > 0) tw = box.w / Math.max(1, Math.round(box.w / tw));
  if (ry === 'round' && th > 0) th = box.h / Math.max(1, Math.round(box.h / th));
  if (rx === 'space' && box.w < tw * 2) rx = 'no-repeat';
  if (ry === 'space' && box.h < th * 2) ry = 'no-repeat';
  const nx = Math.floor(box.w / (tw || 1));
  const ny = Math.floor(box.h / (th || 1));
  const spaceX = rx === 'space' ? (box.w - nx * tw) / Math.max(1, nx - 1) : 0;
  const spaceY = ry === 'space' ? (box.h - ny * th) / Math.max(1, ny - 1) : 0;
  const stepX = tw + spaceX;
  const stepY = th + spaceY;

  let ox = bgPosition(posX, box.w - tw);
  let oy = bgPosition(posY, box.h - th);
  if (rx === 'space') ox = 0;
  if (ry === 'space') oy = 0;
  const repX = rx !== 'no-repeat';
  const repY = ry !== 'no-repeat';
  const startX = repX ? ox - Math.ceil(ox / stepX) * stepX : ox;
  const startY = repY ? oy - Math.ceil(oy / stepY) * stepY : oy;
  const cols = repX ? Math.max(1, Math.ceil((box.w - startX) / stepX)) : 1;
  const rows = repY ? Math.max(1, Math.ceil((box.h - startY) / stepY)) : 1;

  const wrap: FrameNode = { type: 'frame', name, x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), clip: true, children: [] };

  if (asRaster && fill.type === 'image' && (cols > 1 || rows > 1) && rx !== 'space' && ry !== 'space') {
    wrap.children.push({
      type: 'frame',
      name: 'tile',
      x: round(startX),
      y: round(startY),
      w: round(cols * tw),
      h: round(rows * th),
      fills: [{ ...fill, fit: 'tile', tile: { w: round(tw), h: round(th) } }],
      children: [],
    });
    return wrap;
  }

  if (cols * rows > MAX_TILE_COPIES) {
    warn(ctx, 'very dense repeated backgrounds are approximated');
    wrap.children.push({ type: 'frame', name: 'tile', x: 0, y: 0, w: round(box.w), h: round(box.h), fills: [{ ...fill }], children: [] });
    return wrap;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      wrap.children.push({
        type: 'frame',
        name: 'tile',
        x: round(startX + c * stepX),
        y: round(startY + r * stepY),
        w: round(tw),
        h: round(th),
        fills: [{ ...fill }],
        children: [],
      });
    }
  }
  return wrap;
}

function readBackgrounds(cs: CSSStyleDeclaration, w: number, h: number, bl: number, bt: number, br: number, bb: number, ctx: Ctx) {
  const fills: Paint[] = [];
  const bgFrames: FrameNode[] = [];
  const clipText = cs.getPropertyValue('background-clip').includes('text') || cs.getPropertyValue('-webkit-background-clip') === 'text';

  const bg = color(ctx, cs.backgroundColor);
  const image = cs.backgroundImage;
  const layers = image && image !== 'none' ? splitTopLevel(image) : [];

  if (clipText) {
    // The element's text is painted with the background: keep the gradient so text layers can reuse it.
    const g = layers.map((l) => parseGradient(l, { w, h }, ctx.resolveColor)).find(Boolean);
    if (g && 'stops' in g) {
      ctx.gradientText = g.stops[0].color;
      ctx.gradientPaint = g;
    }
    return { fills, bgFrames, clipText };
  }

  if (bg && bg.a > 0) fills.push({ type: 'solid', color: bg });

  const padW = Math.max(0, w - bl - br);
  const padH = Math.max(0, h - bt - bb);
  const area = { x: bl, y: bt, w: padW, h: padH };
  const sizes = splitTopLevel(cs.backgroundSize);
  const poss = splitTopLevel(cs.backgroundPosition);
  const reps = splitTopLevel(cs.backgroundRepeat);

  /** A layer is either a plain fill (covers the whole padding box) or a laid-out frame. */
  type Entry = { fill: Paint } | { frame: FrameNode };
  const entries: Entry[] = []; // top → bottom (CSS order)
  let needFrames = false;

  layers.forEach((layer, i) => {
    const size = pick(sizes, i, 'auto');
    const rep = parseRepeat(pick(reps, i, 'repeat'));
    const pos = tokenize(pick(poss, i, '0% 0%'));
    const posX = pos[0] ?? '0%';
    const posY = pos[1] ?? pos[0] ?? '0%';
    const sz = tokenize(size);

    const grad = parseGradient(layer, { w: padW, h: padH }, ctx.resolveColor);
    if (grad || /^(repeating-)?(linear|radial|conic)-gradient\(/.test(layer)) {
      if (!grad) {
        // conic-gradient(), repeating-*-gradient(), colour-space interpolation…: let the browser draw it, keep the pixels.
        const scale = Math.min(2, Math.sqrt(6_000_000 / Math.max(1, padW * padH)), 2048 / Math.max(1, padW, padH));
        if (!ctx.opts.images || padW < 1 || padH < 1 || scale < 0.25) {
          warn(ctx, 'conic / repeating gradients were skipped');
          return;
        }
        const id = ctx.assets.reserve();
        const css = { layer, size: pick(sizes, i, 'auto'), pos: pick(poss, i, '0% 0%'), rep: pick(reps, i, 'repeat') };
        ctx.jobs.push(async () => {
          const png = await svgToPng(cssBoxSvg(css, padW, padH), padW, padH, scale);
          if (png) {
            ctx.assets.set(id, { kind: 'raster', mime: 'image/png', data: png.data, w: png.w, h: png.h });
            ctx.assets.natural.set(id, { w: padW, h: padH });
          } else ctx.assets.failed.add(id);
        });
        entries.push({ fill: { type: 'image', asset: id, fit: 'stretch' } });
        return;
      }
      const tw = size === 'cover' || size === 'contain' ? padW : (sizeDim(sz[0], padW) ?? padW);
      const th = size === 'cover' || size === 'contain' ? padH : (sizeDim(sz[1] ?? 'auto', padH) ?? padH);
      const full = Math.abs(tw - padW) < 0.5 && Math.abs(th - padH) < 0.5;
      if (full || tw <= 0 || th <= 0) {
        entries.push({ fill: grad });
        return;
      }
      // The gradient must be generated for the tile size, not the whole box.
      const tileGrad = parseGradient(layer, { w: tw, h: th }, ctx.resolveColor) ?? grad;
      needFrames = true;
      const repeats = rep[0] !== 'no-repeat' || rep[1] !== 'no-repeat';
      const svg = repeats && ctx.opts.images ? gradientSvg(tileGrad, tw, th) : null;
      if (svg) {
        // Repeating pattern: bake one tile into a PNG and let Figma tile it (1 layer instead of dozens).
        const id = ctx.assets.reserve();
        ctx.jobs.push(async () => {
          const png = await svgToPng(svg, tw, th, 2);
          if (png) {
            ctx.assets.set(id, { kind: 'raster', mime: 'image/png', data: png.data, w: png.w, h: png.h });
            ctx.assets.natural.set(id, { w: tw, h: th });
          } else ctx.assets.failed.add(id);
        });
        entries.push({ frame: layoutTiles('background-gradient', { type: 'image', asset: id, fit: 'stretch' }, tw, th, posX, posY, rep, area, ctx, true) });
      } else {
        entries.push({ frame: layoutTiles('background-gradient', tileGrad, tw, th, posX, posY, rep, area, ctx, false) });
      }
      return;
    }

    const m = /url\((['"]?)(.*?)\1\)/.exec(layer);
    if (!m || !ctx.opts.images) return;
    const asset = ctx.assets.request(m[2]);
    if (size === 'cover') return void entries.push({ fill: { type: 'image', asset, fit: 'fill', pos: fractions(posX, posY) } });
    const centred = /^(50%|center)$/;
    if (size === 'contain' && rep[0] === 'no-repeat' && rep[1] === 'no-repeat' && centred.test(posX) && centred.test(posY))
      return void entries.push({ fill: { type: 'image', asset, fit: 'fit' } });

    // Explicit size / natural size / positioned / repeated → laid out once the image size is known.
    needFrames = true;
    if (rep[0] !== 'no-repeat' || rep[1] !== 'no-repeat') ctx.rasterSvgs.add(asset);
    const wrap: FrameNode = { type: 'frame', name: 'background-image', x: bl, y: bt, w: padW, h: padH, clip: true, children: [] };
    ctx.deferred.push(() => {
      const assetData = ctx.assets.get(asset);
      const nat = ctx.assets.natural.get(asset) ?? assetSize(assetData);
      const ratio = nat && nat.h ? nat.w / nat.h : 1;
      let iw: number | null;
      let ih: number | null;
      if (size === 'contain' || size === 'cover') {
        const k = size === 'contain' ? Math.min(padW / (nat?.w || padW), padH / (nat?.h || padH)) : Math.max(padW / (nat?.w || padW), padH / (nat?.h || padH));
        iw = (nat?.w ?? padW) * k;
        ih = (nat?.h ?? padH) * k;
      } else {
        iw = sizeDim(sz[0], padW);
        ih = sizeDim(sz[1] ?? 'auto', padH);
        if (iw === null && ih === null) {
          iw = nat?.w ?? padW;
          ih = nat?.h ?? padH;
        } else if (iw === null) iw = (ih as number) * ratio;
        else if (ih === null) ih = iw / ratio;
      }
      const laid = layoutTiles('background-image', { type: 'image', asset, fit: 'stretch' }, iw as number, ih as number, posX, posY, rep, area, ctx, assetData?.kind === 'raster');
      wrap.children = laid.children;
    });
    entries.push({ frame: wrap });
  });

  const bottomUp = entries.reverse();
  if (needFrames) {
    // Keep CSS layer order: every layer becomes a frame above the background colour.
    for (const e of bottomUp) {
      if ('frame' in e) bgFrames.push(e.frame);
      else bgFrames.push({ type: 'frame', name: 'background-layer', x: bl, y: bt, w: padW, h: padH, fills: [e.fill], children: [] });
    }
  } else {
    for (const e of bottomUp) if ('fill' in e) fills.push(e.fill);
  }
  return { fills, bgFrames, clipText };
}

export function readBox(el: Element, cs: CSSStyleDeclaration, w: number, h: number, ctx: Ctx): BoxStyle {
  const bt = px(cs.borderTopWidth);
  const br = px(cs.borderRightWidth);
  const bb = px(cs.borderBottomWidth);
  const bl = px(cs.borderLeftWidth);

  const { fills, bgFrames, clipText } = readBackgrounds(cs, w, h, bl, bt, br, bb, ctx);

  let stroke: Stroke | undefined;
  const sides = [
    ['top', bt, cs.borderTopColor, cs.borderTopStyle],
    ['right', br, cs.borderRightColor, cs.borderRightStyle],
    ['bottom', bb, cs.borderBottomColor, cs.borderBottomStyle],
    ['left', bl, cs.borderLeftColor, cs.borderLeftStyle],
  ] as const;
  const visible = sides.filter(([, width, , style]) => width > 0 && style !== 'none' && style !== 'hidden');
  if (visible.length) {
    const c = color(ctx, visible[0][2]);
    if (c && c.a > 0) {
      const w4 = (side: string) => {
        const s = visible.find(([n]) => n === side);
        return s ? s[1] : 0;
      };
      const style = visible[0][3];
      stroke = {
        top: w4('top'),
        right: w4('right'),
        bottom: w4('bottom'),
        left: w4('left'),
        color: c,
        dash: style === 'dashed' ? 'dashed' : style === 'dotted' ? 'dotted' : undefined,
      };
    }
  }

  const rad: Corners = [
    parseRadius(cs.borderTopLeftRadius, w, h),
    parseRadius(cs.borderTopRightRadius, w, h),
    parseRadius(cs.borderBottomRightRadius, w, h),
    parseRadius(cs.borderBottomLeftRadius, w, h),
  ].map((n) => round(n)) as Corners;
  const radius = rad.some((r) => r > 0) ? rad : undefined;

  const shadows = parseShadows(cs.boxShadow, ctx.resolveColor);
  // filter: drop-shadow(x y blur color) maps onto a Figma drop shadow; other colour filters can't be reproduced.
  if (cs.filter && cs.filter !== 'none') {
    for (const m of cs.filter.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)) shadows.push(...parseShadows(m[1], ctx.resolveColor));
    if (/(brightness|contrast|grayscale|hue-rotate|invert|saturate|sepia)\(/.test(cs.filter)) warn(ctx, 'CSS colour filters (brightness, contrast, grayscale…) are not applied');
  }

  const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

  const blurMatch = /blur\(([\d.]+)px\)/.exec(cs.filter);
  const bgf = cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter');
  const bgMatch = /blur\(([\d.]+)px\)/.exec(bgf);

  return {
    fills,
    bgFrames,
    stroke,
    radius,
    shadows,
    clip,
    blur: blurMatch ? parseFloat(blurMatch[1]) : undefined,
    bgBlur: bgMatch ? parseFloat(bgMatch[1]) : undefined,
    blend: BLEND[cs.mixBlendMode],
    clipText,
  };
}

export function hasVisual(b: BoxStyle): boolean {
  return b.fills.length > 0 || !!b.stroke || b.shadows.length > 0 || b.bgFrames.length > 0 || !!b.blur || !!b.bgBlur;
}
