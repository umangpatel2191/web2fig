import type { ImportOptions, ImportResult } from '../../../shared/messages';
import type { CaptureFile, FontSpec, FrameNode as CapturedFrame, LayerNode, SvgLayer, TextLayer } from '../../../shared/schema';
import { FontResolver } from './fonts';
import { planAutoLayout } from './layout';
import { toEffects, toFigmaPaint, solid, type PaintEnv } from './paints';
import { createColorTokens } from './tokens';

export interface Hooks {
  progress(done: number, total: number, stage: string): void;
  cancelled(): boolean;
}

export class CancelledError extends Error {}

interface State {
  file: CaptureFile;
  opts: ImportOptions;
  fonts: FontResolver;
  env: PaintEnv;
  hooks: Hooks;
  total: number;
  done: number;
  layers: number;
  autoLayouts: number;
  candidates: number;
  warnings: Set<string>;
  root: FrameNode | null;
  /** Text styles by typography key (only for typography that repeats). */
  textStyles: Map<string, TextStyle>;
}
type Parent = ChildrenMixin & BaseNode;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const AUTO_LAYOUT_TOLERANCE = 2;

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function countNodes(n: LayerNode): number {
  return n.type === 'frame' ? 1 + n.children.reduce((s, c) => s + countNodes(c), 0) : 1;
}

function collectFonts(n: LayerNode, out: FontSpec[] = []): FontSpec[] {
  if (n.type === 'text') out.push(n.font);
  else if (n.type === 'frame') n.children.forEach((c) => collectFonts(c, out));
  return out;
}

/** Rewrites the root <svg> tag so it renders at exactly w×h. */
export function normalizeSvg(svg: string, w: number, h: number, preserveAspectRatio?: string): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs;
    const num = (name: string) => {
      const m = new RegExp(`\\s${name}=["']([\\d.]+)(?:px)?["']`, 'i').exec(a);
      return m ? parseFloat(m[1]) : null;
    };
    if (!/\sviewBox=/i.test(a)) {
      const aw = num('width');
      const ah = num('height');
      if (aw && ah) a += ` viewBox="0 0 ${aw} ${ah}"`;
    }
    a = a.replace(/\s(?:width|height)=["'][^"']*["']/gi, '').replace(/\spreserveAspectRatio=["'][^"']*["']/i, '');
    if (!/\sxmlns=/i.test(a)) a += ' xmlns="http://www.w3.org/2000/svg"';
    const par = preserveAspectRatio ? ` preserveAspectRatio="${preserveAspectRatio}"` : '';
    return `<svg${a} width="${w}" height="${h}"${par}>`;
  });
}

function makeSvg(markup: string, w: number, h: number, name: string, par?: string): FrameNode | null {
  try {
    const node = figma.createNodeFromSvg(normalizeSvg(markup, Math.max(w, 1), Math.max(h, 1), par));
    node.name = name;
    return node;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Node builders                                                       */
/* ------------------------------------------------------------------ */

async function checkpoint(st: State): Promise<void> {
  if (st.hooks.cancelled()) throw new CancelledError();
  st.done++;
  st.layers++;
  if (st.done % 40 === 0) {
    st.hooks.progress(st.done, st.total, 'Building layers');
    await tick();
  }
}

function applyCommon(node: SceneNode & BlendMixin, n: LayerNode): void {
  if (n.opacity !== undefined) node.opacity = n.opacity;
  if ('blend' in n && n.blend) node.blendMode = n.blend as BlendMode;
  if (n.rel) {
    const [a, b, c, d, tx, ty] = n.rel;
    try {
      (node as SceneNode & { relativeTransform: Transform }).relativeTransform = [
        [a, c, tx],
        [b, d, ty],
      ];
    } catch {
      /* keep the untransformed position */
    }
  }
}

async function buildFrame(n: CapturedFrame, parent: Parent, st: State): Promise<FrameNode> {
  await checkpoint(st);
  const f = figma.createFrame();
  if (!st.root) st.root = f;
  f.name = n.name;
  f.fills = [];
  f.clipsContent = !!n.clip;
  f.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  parent.appendChild(f);
  f.x = n.x;
  f.y = n.y;
  applyCommon(f, n);

  // Fills: raster/gradient/solid become paints; SVG backgrounds become a child layer.
  const paints: Paint[] = [];
  const svgBackgrounds: { markup: string; par: string }[] = [];
  for (const p of n.fills ?? []) {
    if (p.type === 'image') {
      const asset = st.file.assets[p.asset];
      if (asset?.kind === 'svg') {
        if (st.opts.images) svgBackgrounds.push({ markup: asset.svg, par: p.fit === 'fill' ? 'xMidYMid slice' : p.fit === 'stretch' ? 'none' : 'xMidYMid meet' });
        continue;
      }
    }
    const paint = toFigmaPaint(p, n.w, n.h, st.env);
    if (paint) paints.push(paint);
  }
  f.fills = paints;

  if (n.stroke) {
    const s = n.stroke;
    f.strokes = [solid(s.color, st.env)];
    f.strokeAlign = 'INSIDE';
    f.strokeTopWeight = s.top;
    f.strokeRightWeight = s.right;
    f.strokeBottomWeight = s.bottom;
    f.strokeLeftWeight = s.left;
    const w = Math.max(s.top, s.right, s.bottom, s.left);
    if (s.dash === 'dashed') f.dashPattern = [w * 3, w * 2];
    else if (s.dash === 'dotted') {
      f.dashPattern = [w, w * 1.5];
      f.strokeCap = 'ROUND';
    }
  }

  if (n.radius) {
    const [tl, tr, br, bl] = n.radius;
    if (tl === tr && tr === br && br === bl) f.cornerRadius = tl;
    else {
      f.topLeftRadius = tl;
      f.topRightRadius = tr;
      f.bottomRightRadius = br;
      f.bottomLeftRadius = bl;
    }
  }

  const effects = toEffects(n.shadows, { blur: n.blur, bgBlur: n.bgBlur });
  if (effects.length) f.effects = effects;

  const built: { data: LayerNode; node: SceneNode }[] = [];
  const absExtras: SceneNode[] = [];
  const masked = n.clipShape || n.mask ? applyMask(f, n, st) : false;

  for (const bg of svgBackgrounds) {
    const svg = makeSvg(bg.markup, n.w, n.h, 'background-svg', bg.par);
    if (svg) {
      f.appendChild(svg);
      svg.x = 0;
      svg.y = 0;
      absExtras.push(svg);
      st.layers++;
    }
  }

  for (const child of n.children) {
    const node = await buildNode(child, f, st);
    if (node) built.push({ data: child, node });
  }

  if (st.opts.autoLayout && !masked) tryAutoLayout(f, built, absExtras, st);
  if (f.layoutMode === 'NONE') applyConstraints(f, built);
  return f;
}

/** SVG-ish path data for a polygon. */
function polyData(pts: [number, number][]): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ') + ' Z';
}

/**
 * clip-path / mask-image → a mask layer. Figma masks cover the siblings stacked above them, never the frame's own
 * fill, so the frame's paint moves into a child "surface" placed above the mask. Falls back to an unmasked frame.
 */
function applyMask(f: FrameNode, n: CapturedFrame, st: State): boolean {
  const created: SceneNode[] = [];
  try {
    let mask: SceneNode & { isMask: boolean };
    const s = n.clipShape;
    if (s?.kind === 'rect') {
      const r = figma.createRectangle();
      r.resize(Math.max(s.w, 0.01), Math.max(s.h, 0.01));
      const [tl, tr, br, bl] = s.r;
      r.topLeftRadius = tl;
      r.topRightRadius = tr;
      r.bottomRightRadius = br;
      r.bottomLeftRadius = bl;
      f.appendChild(r);
      r.x = s.x;
      r.y = s.y;
      mask = r;
    } else if (s?.kind === 'ellipse') {
      const e = figma.createEllipse();
      e.resize(Math.max(s.rx * 2, 0.01), Math.max(s.ry * 2, 0.01));
      f.appendChild(e);
      e.x = s.cx - s.rx;
      e.y = s.cy - s.ry;
      mask = e;
    } else if (s) {
      const v = figma.createVector();
      v.vectorPaths = [{ windingRule: s.evenodd ? 'EVENODD' : 'NONZERO', data: s.kind === 'poly' ? polyData(s.pts) : s.d }];
      f.appendChild(v);
      mask = v;
    } else if (n.mask) {
      const r = figma.createRectangle();
      r.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
      const paint = toFigmaPaint(n.mask, n.w, n.h, st.env);
      if (!paint) return false;
      r.fills = [paint];
      f.appendChild(r);
      r.x = 0;
      r.y = 0;
      try {
        (r as RectangleNode & { maskType: string }).maskType = 'ALPHA';
      } catch {
        /* older API: alpha is the default */
      }
      mask = r;
    } else return false;
    created.push(mask);
    mask.name = 'mask';
    mask.isMask = true;

    const surface = figma.createRectangle();
    surface.name = 'surface';
    surface.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
    f.appendChild(surface);
    surface.x = 0;
    surface.y = 0;
    created.push(surface);
    surface.fills = f.fills as Paint[];
    surface.strokes = f.strokes as Paint[];
    if (f.strokes.length) {
      surface.strokeAlign = 'INSIDE';
      surface.strokeTopWeight = f.strokeTopWeight;
      surface.strokeRightWeight = f.strokeRightWeight;
      surface.strokeBottomWeight = f.strokeBottomWeight;
      surface.strokeLeftWeight = f.strokeLeftWeight;
    }
    if (f.cornerRadius !== figma.mixed) surface.cornerRadius = f.cornerRadius as number;
    else {
      surface.topLeftRadius = f.topLeftRadius;
      surface.topRightRadius = f.topRightRadius;
      surface.bottomRightRadius = f.bottomRightRadius;
      surface.bottomLeftRadius = f.bottomLeftRadius;
    }
    f.fills = [];
    f.strokes = [];
    st.layers += 2;
    return true;
  } catch {
    for (const c of created) c.remove();
    return false;
  }
}

const typoKey = (f: FontSpec, font: { family: string; style: string }) => `${font.family}|${font.style}|${f.size}|${f.lineHeight}|${f.letterSpacing}|${f.decoration}`;

/** Creates (or reuses) text styles for typography used at least three times. */
async function prepareTextStyles(file: CaptureFile, fonts: FontResolver, st: State): Promise<void> {
  const counts = new Map<string, { spec: FontSpec; n: number }>();
  for (const spec of collectFonts(file.root)) {
    const k = typoKey(spec, fonts.resolve(spec));
    const c = counts.get(k) ?? { spec, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const wanted = [...counts.entries()].filter(([, c]) => c.n >= 3).sort((a, b) => b[1].n - a[1].n).slice(0, 40);
  if (wanted.length === 0) return;
  const existing = new Map<string, TextStyle>();
  try {
    for (const s of await figma.getLocalTextStylesAsync()) existing.set(s.name, s);
  } catch {
    /* older API surface: always create */
  }
  for (const [key, { spec }] of wanted) {
    try {
      const font = fonts.resolve(spec);
      const name = `Web2Fig/${font.family} ${font.style} · ${Math.round(spec.size)}/${Math.round(spec.lineHeight)}${spec.letterSpacing ? ` · ${spec.letterSpacing > 0 ? '+' : ''}${spec.letterSpacing}` : ''}`;
      let style = existing.get(name);
      if (!style) {
        style = figma.createTextStyle();
        style.name = name;
        style.fontName = font;
        style.fontSize = Math.max(1, spec.size);
        style.lineHeight = { unit: 'PIXELS', value: Math.max(1, spec.lineHeight) };
        style.letterSpacing = { unit: 'PIXELS', value: spec.letterSpacing };
        style.textDecoration = spec.decoration === 'underline' ? 'UNDERLINE' : spec.decoration === 'line-through' ? 'STRIKETHROUGH' : 'NONE';
      }
      st.textStyles.set(key, style);
    } catch {
      /* a style that can't be created just means that text stays unstyled */
    }
  }
}

async function buildText(n: TextLayer, parent: Parent, st: State): Promise<SceneNode> {
  await checkpoint(st);
  const t = figma.createText();
  t.fontName = st.fonts.resolve(n.font);
  t.characters = n.text;
  t.fontSize = Math.max(1, n.font.size);
  t.lineHeight = { unit: 'PIXELS', value: Math.max(1, n.font.lineHeight) };
  t.letterSpacing = { unit: 'PIXELS', value: n.font.letterSpacing };
  t.textAlignHorizontal = n.font.align === 'center' ? 'CENTER' : n.font.align === 'right' ? 'RIGHT' : 'LEFT';
  t.textDecoration = n.font.decoration === 'underline' ? 'UNDERLINE' : n.font.decoration === 'line-through' ? 'STRIKETHROUGH' : 'NONE';
  const gradient = n.paint ? toFigmaPaint(n.paint, Math.max(1, n.w), Math.max(1, n.h), st.env) : null;
  t.fills = [gradient ?? solid(n.color, st.env)];
  const fx = toEffects(n.shadows, { textOnly: true });
  if (fx.length) t.effects = fx;
  t.textAutoResize = 'WIDTH_AND_HEIGHT';
  const style = st.textStyles.get(typoKey(n.font, st.fonts.resolve(n.font)));
  if (style) {
    try {
      await t.setTextStyleIdAsync(style.id);
    } catch {
      /* keep the local formatting */
    }
  }
  parent.appendChild(t);
  applyCommon(t, n);

  // Fitting: when the page's font isn't available in Figma, spread/tighten the letters so every line ends
  // where it ended in the browser instead of overlapping its neighbours.
  fitWidth(t, n, st);

  if (n.href) {
    try {
      t.setRangeHyperlink(0, t.characters.length, { type: 'URL', value: n.href });
    } catch {
      /* unsupported URL – keep plain text */
    }
  }
  if (n.stroke) {
    t.strokes = [solid(n.stroke.color, st.env)];
    t.strokeWeight = n.stroke.w;
    t.strokeAlign = 'CENTER';
  }

  // The browser's box is authoritative: keep the same anchor edge even if our font is a bit wider.
  const w = t.width;
  t.x = n.font.align === 'center' ? n.x + n.w / 2 - w / 2 : n.font.align === 'right' ? n.x + n.w - w : n.x;
  t.y = n.y;
  return t;
}

/**
 * Resize behaviour inferred from where each child sits: centred → CENTER, pinned right/bottom → MAX,
 * spanning the frame → STRETCH, otherwise MIN. Resizing the imported frame then behaves like the web page.
 */
function applyConstraints(f: FrameNode, built: { data: LayerNode; node: SceneNode }[]): void {
  const W = f.width;
  const H = f.height;
  const axis = (pos: number, size: number, total: number): 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' => {
    const a = pos;
    const b = total - (pos + size);
    if (a <= 1 && b <= 1 && size > 1) return 'STRETCH';
    if (Math.abs(a - b) <= 1 && a > 2) return 'CENTER';
    if (b < a * 0.5 && b <= 40) return 'MAX';
    return 'MIN';
  };
  for (const { node } of built) {
    try {
      (node as SceneNode & ConstraintMixin).constraints = {
        horizontal: axis(node.x, node.width, W),
        vertical: axis(node.y, node.height, H),
      };
    } catch {
      /* node type without constraints */
    }
  }
}

function fitWidth(t: TextNode, n: TextLayer, st: State): void {
  const lines = n.text.split('\n');
  const widest = Math.max(...lines.map((l) => l.length));
  if (widest < 2 || n.w <= 0) return;
  const delta = n.w - t.width;
  const substituted = st.fonts.isSubstituted(n.font);
  if (Math.abs(delta) < (substituted ? 0.6 : 2.5)) return;
  if (!substituted && Math.abs(delta) / n.w < 0.03) return; // same font, just sub-pixel shaping differences
  const per = delta / widest;
  const next = n.font.letterSpacing + Math.max(-2, Math.min(4, per));
  t.letterSpacing = { unit: 'PIXELS', value: next };
}

async function buildSvg(n: SvgLayer, parent: Parent, st: State): Promise<SceneNode | null> {
  await checkpoint(st);
  const markup = n.svg ?? (n.asset && st.file.assets[n.asset]?.kind === 'svg' ? (st.file.assets[n.asset] as { svg: string }).svg : null);
  const node = markup ? makeSvg(markup, n.w, n.h, n.name) : null;
  if (!node) {
    st.warnings.add('Some SVG graphics could not be converted and were left empty');
    const empty = figma.createFrame();
    empty.name = `${n.name} (unsupported SVG)`;
    empty.fills = [];
    empty.resize(Math.max(n.w, 1), Math.max(n.h, 1));
    parent.appendChild(empty);
    empty.x = n.x;
    empty.y = n.y;
    return empty;
  }
  parent.appendChild(node);
  node.x = n.x;
  node.y = n.y;
  applyCommon(node, n);
  return node;
}

async function buildNode(n: LayerNode, parent: Parent, st: State): Promise<SceneNode | null> {
  switch (n.type) {
    case 'frame':
      return buildFrame(n, parent, st);
    case 'text':
      return buildText(n, parent, st);
    case 'svg':
      return buildSvg(n, parent, st);
  }
}

/* ------------------------------------------------------------------ */
/* Auto Layout                                                         */
/* ------------------------------------------------------------------ */

function tryAutoLayout(f: FrameNode, built: { data: LayerNode; node: SceneNode }[], absExtras: SceneNode[], st: State): void {
  if (built.some((b) => b.data.rel)) return; // transformed children stay absolute
  const flow = built.filter((b) => !b.data.abs);
  if (flow.length < 2) return;
  st.candidates++;

  const boxes = flow.map((b) => ({ x: b.node.x, y: b.node.y, w: b.node.width, h: b.node.height }));
  const plan = planAutoLayout({ w: f.width, h: f.height }, boxes);
  if (!plan) return;

  const all = [...built.map((b) => b.node), ...absExtras];
  const before = new Map(all.map((n) => [n, { x: n.x, y: n.y }]));
  const w = f.width;
  const h = f.height;

  try {
    f.layoutMode = plan.mode;
    f.primaryAxisSizingMode = 'FIXED';
    f.counterAxisSizingMode = 'FIXED';
    f.resize(w, h);
    f.itemSpacing = plan.gap;
    if (plan.wrap) {
      (f as FrameNode & { layoutWrap: string }).layoutWrap = 'WRAP';
      f.counterAxisSpacing = plan.counterGap ?? 0;
    }
    f.paddingTop = plan.padTop;
    f.paddingRight = plan.padRight;
    f.paddingBottom = plan.padBottom;
    f.paddingLeft = plan.padLeft;
    f.primaryAxisAlignItems = 'MIN';
    f.counterAxisAlignItems = plan.counter;

    for (const b of built) if (b.data.abs) (b.node as SceneNode & { layoutPositioning: string }).layoutPositioning = 'ABSOLUTE';
    for (const n of absExtras) (n as SceneNode & { layoutPositioning: string }).layoutPositioning = 'ABSOLUTE';
    for (const n of [...built.filter((b) => b.data.abs).map((b) => b.node), ...absExtras]) {
      const o = before.get(n)!;
      n.x = o.x;
      n.y = o.y;
    }

    // Verify: Auto Layout must land every child where the browser put it.
    const ok = flow.every((b, i) => {
      const o = boxes[i];
      return Math.abs(b.node.x - o.x) <= AUTO_LAYOUT_TOLERANCE && Math.abs(b.node.y - o.y) <= AUTO_LAYOUT_TOLERANCE;
    }) && Math.abs(f.width - w) < 0.5 && Math.abs(f.height - h) < 0.5;
    if (!ok) throw new Error('layout mismatch');
    // Children that span the whole cross axis keep doing so when the frame is resized.
    for (const b of flow) {
      if (b.node.type !== 'FRAME') continue;
      const spans = plan.mode === 'VERTICAL' ? Math.abs(b.node.width - (w - plan.padLeft - plan.padRight)) < 0.5 : Math.abs(b.node.height - (h - plan.padTop - plan.padBottom)) < 0.5;
      if (spans) {
        try {
          (b.node as FrameNode).layoutAlign = 'STRETCH';
        } catch {
          /* optional */
        }
      }
    }
    st.autoLayouts++;
  } catch {
    f.layoutMode = 'NONE';
    f.resize(w, h);
    for (const [n, o] of before) {
      n.x = o.x;
      n.y = o.y;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function importCapture(file: CaptureFile, opts: ImportOptions, hooks: Hooks): Promise<ImportResult> {
  const t0 = Date.now();
  // The main layout, plus any extra sizes of a responsive set.
  const layouts: { file: CaptureFile; label: string }[] = [
    { file, label: file.label ?? '' },
    ...(file.breakpoints ?? []).map((b) => ({ file: b.file, label: b.label })),
  ];
  const total = layouts.reduce((s, l) => s + countNodes(l.file.root), 0);

  hooks.progress(0, total, 'Preparing fonts');
  const fonts = new FontResolver();
  await fonts.init();
  await fonts.preload(layouts.flatMap((l) => collectFonts(l.file.root)));

  hooks.progress(0, total, 'Creating color variables');
  const tokens = opts.variables ? createColorTokens(file) : new Map<string, Variable>();

  const st: State = {
    file,
    opts,
    fonts,
    env: { assets: file.assets, imageHashes: new Map(), tokens, useImages: opts.images, stats: { images: 0, imagesFailed: 0 } },
    hooks,
    total,
    done: 0,
    layers: 0,
    autoLayouts: 0,
    candidates: 0,
    warnings: new Set(),
    root: null,
    textStyles: new Map(),
  };
  const stats = { images: 0, imagesFailed: 0 };
  const roots: FrameNode[] = [];
  const warnings = new Set<string>();

  let createdPage: PageNode | null = null;
  try {
    if (opts.newPage) {
      createdPage = figma.createPage();
      createdPage.name = `Web2Fig · ${(file.source.title || file.source.url).replace(/^https?:\/\//, '').slice(0, 40)}`;
      await figma.setCurrentPageAsync(createdPage);
    }

    for (const layout of layouts) {
      const f = layout.file;
      st.file = f;
      st.root = null;
      st.env = { assets: f.assets, imageHashes: new Map(), tokens, useImages: opts.images, stats: { images: 0, imagesFailed: 0 } };
      if (opts.textStyles) await prepareTextStyles(f, fonts, st);
      if (layout.label && layouts.length > 1) f.root.name = `${layout.label}  ·  ${f.root.name}`.slice(0, 90);
      const root = await buildFrame(f.root, figma.currentPage, st);
      roots.push(root);
      stats.images += st.env.stats.images;
      stats.imagesFailed += st.env.stats.imagesFailed;
      f.warnings.forEach((w) => warnings.add(w));
    }
    st.warnings.forEach((w) => warnings.add(w));
    hooks.progress(total, total, 'Finishing');

    // Lay the sizes out left to right with a gap, centred in the current view.
    const gap = 160;
    const span = roots.reduce((sum, r) => sum + r.width, 0) + gap * (roots.length - 1);
    const c = figma.viewport.center;
    let x = Math.round(c.x - span / 2);
    const y = Math.round(c.y - Math.min(roots[0].height, 900) / 2);
    for (const r of roots) {
      r.x = x;
      r.y = y;
      x += r.width + gap;
    }
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);

    return {
      layers: st.layers,
      autoLayouts: st.autoLayouts,
      autoLayoutCandidates: st.candidates,
      images: stats.images,
      imagesFailed: stats.imagesFailed,
      variables: tokens.size,
      substitutions: fonts.substitutions(layouts.flatMap((l) => l.file.fonts)),
      warnings: [...warnings],
      ms: Date.now() - t0,
    };
  } catch (e) {
    for (const r of roots) r.remove();
    st.root?.remove();
    if (createdPage) {
      try {
        createdPage.remove();
      } catch {
        /* page can't be removed while it is the only one */
      }
    }
    throw e;
  }
}
