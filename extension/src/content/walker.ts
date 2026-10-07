import { round } from '../../../shared/css';
import type { ClipShape, FrameNode, LayerNode, Paint, RGBA, Stroke, SvgLayer, TextLayer } from '../../../shared/schema';
import { color, warn, type Ctx, type ElementTransform, type Origin } from './context';
import { canvasColor, createsStackingContext, paintKey, prepareDocument } from './prepare';
import { fractions, hasVisual, readBox, type BoxStyle } from './style';
import { readClipShape, readMask } from './shape';
import { serializeSvg } from './svg';
import { syntheticText, textLayers } from './text';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'source', 'track', 'param', 'area', 'map', 'br', 'wbr', 'datalist']);
const REPLACED = new Set(['img', 'canvas', 'video', 'iframe', 'embed', 'object']);
const VOID = new Set(['img', 'input', 'br', 'hr', 'canvas', 'video', 'audio', 'iframe', 'embed', 'object', 'textarea', 'select', 'meter', 'progress']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const PLACEHOLDER: Paint = { type: 'solid', color: { r: 0.9, g: 0.91, b: 0.93, a: 1 } };
const MAX_IFRAME_DEPTH = 3;

const px = (v: string) => parseFloat(v) || 0;
const tagOf = (el: Element) => el.tagName.toLowerCase();
const isSvgRoot = (el: Element) => el.namespaceURI === SVG_NS && tagOf(el) === 'svg';

/* ------------------------------------------------------------------ */
/* Paint order                                                         */
/* ------------------------------------------------------------------ */

/**
 * Layers are collected per *paint boundary* (the root, a stacking context, or an overflow-clipping element).
 * An item may be hoisted out of its DOM parent into the boundary's list, so that z-index / positioned
 * elements interleave with the rest of the context exactly like in the browser — a negative z-index
 * overlay goes behind the content, a dropdown or fixed header goes in front of it even though it sits in a
 * different subtree. `order` is the pre-order tree index, used to break ties.
 */
export interface Item {
  n: LayerNode;
  key: number;
  order: number;
}
export interface Col {
  items: Item[];
  x: number;
  y: number;
}

export const newCol = (origin: Origin): Col => ({ items: [], x: origin.x, y: origin.y });

export function finish(items: Item[]): LayerNode[] {
  return items
    .slice()
    .sort((a, b) => a.key - b.key || a.order - b.order)
    .map((i) => i.n);
}

export function walkRoot(parent: Element | ShadowRoot, origin: Origin, ctx: Ctx): LayerNode[] {
  const col = newCol(origin);
  walkKids(parent, origin, col, col.items, ctx);
  return finish(col.items);
}

export function walkSingle(el: Element, origin: Origin, ctx: Ctx): LayerNode[] {
  const col = newCol(origin);
  walkElement(el, origin, col, col.items, ctx);
  return finish(col.items);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function childNodesOf(el: Element | ShadowRoot): Node[] {
  if (el instanceof Element && tagOf(el) === 'slot') {
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    return assigned.length ? assigned : Array.from(el.childNodes);
  }
  if (el instanceof Element && el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  return Array.from(el.childNodes);
}

const FRIENDLY: Record<string, string> = {
  header: 'Header', nav: 'Nav', main: 'Main', footer: 'Footer', section: 'Section', article: 'Article', aside: 'Aside',
  ul: 'List', ol: 'List', li: 'List item', a: 'Link', button: 'Button', form: 'Form', label: 'Label', input: 'Input',
  textarea: 'Textarea', select: 'Select', img: 'Image', picture: 'Image', video: 'Video', canvas: 'Canvas', iframe: 'Embed',
  figure: 'Figure', figcaption: 'Caption', table: 'Table', tr: 'Row', td: 'Cell', th: 'Cell', p: 'Paragraph',
  blockquote: 'Quote', dialog: 'Dialog', details: 'Details', summary: 'Summary', hr: 'Divider', svg: 'Graphic',
  h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6',
};
const ROLES: Record<string, string> = { button: 'Button', link: 'Link', navigation: 'Nav', banner: 'Header', contentinfo: 'Footer', main: 'Main', dialog: 'Dialog', tab: 'Tab', tablist: 'Tabs', menu: 'Menu', menuitem: 'Menu item', list: 'List', listitem: 'List item', img: 'Image', search: 'Search' };
const NAMED_BY_TEXT = new Set(['a', 'button', 'summary', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th', 'figcaption']);

function fileName(url: string): string {
  try {
    const u = new URL(url, document.baseURI);
    const n = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return /^data:/.test(url) ? '' : n.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 28);
  } catch {
    return '';
  }
}

/** Layer names designers can navigate: "Button · Speak to us", "Image · hero-laptop", "Section · pricing". */
function layerName(el: Element, tag: string): string {
  const pseudo = el.getAttribute('data-wf-pseudo');
  if (pseudo) return `${el.parentElement ? tagOf(el.parentElement) : ''}::${pseudo}`;
  const role = el.getAttribute('role');
  const friendly = FRIENDLY[tag] ?? (role ? ROLES[role] : undefined);
  const aria = el.getAttribute('aria-label');
  const id = el.id && !/^\d|[0-9a-f]{8,}/i.test(el.id) ? el.id : '';
  const cls = Array.from(el.classList).find((c) => c.length <= 24 && !/^(css|sc|jsx|_)|[0-9a-f]{6,}|\d{3,}/i.test(c)) ?? '';

  if (!friendly) {
    if (aria) return aria.slice(0, 48);
    if (id) return `${tag}#${id}`.slice(0, 48);
    return cls ? `${tag}.${cls}` : tag;
  }
  let detail = '';
  if (aria) detail = aria;
  else if (tag === 'img') detail = el.getAttribute('alt')?.trim() || fileName((el as HTMLImageElement).currentSrc || el.getAttribute('src') || '');
  else if (NAMED_BY_TEXT.has(tag) || role === 'button' || role === 'link' || role === 'tab') detail = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!detail) detail = id || (tag === 'input' ? (el as HTMLInputElement).placeholder || (el as HTMLInputElement).type : '') || cls.replace(/[-_]+/g, ' ');
  return detail ? `${friendly} · ${detail}`.slice(0, 56) : friendly;
}

function outside(x: number, y: number, w: number, h: number, ctx: Ctx): boolean {
  return x + w < -1 || y + h < -1 || x > ctx.bounds.w + 1 || y > ctx.bounds.h + 1;
}

function frame(name: string, x: number, y: number, w: number, h: number, box: BoxStyle | null, children: LayerNode[]): FrameNode {
  const f: FrameNode = { type: 'frame', name, x: round(x), y: round(y), w: round(w), h: round(h), children };
  if (box) {
    if (box.fills.length) f.fills = box.fills;
    if (box.stroke) f.stroke = box.stroke;
    if (box.radius) f.radius = box.radius;
    if (box.shadows.length) f.shadows = box.shadows;
    if (box.clip) f.clip = true;
    if (box.blur) f.blur = box.blur;
    if (box.bgBlur) f.bgBlur = box.bgBlur;
    if (box.blend) f.blend = box.blend;
  }
  return f;
}

function applyCommon(n: LayerNode, cs: CSSStyleDeclaration, abs: boolean): void {
  const o = parseFloat(cs.opacity);
  if (o < 1) n.opacity = round(o, 3);
  if (abs) n.abs = true;
}

/** Local → parent transform of a frame laid out at (x, y) with CSS transform `t` about its origin. */
function setRel(n: LayerNode, t: ElementTransform, x: number, y: number): void {
  const [a, b, c, d, e, f] = t.m;
  n.rel = [round(a, 5), round(b, 5), round(c, 5), round(d, 5), round(x + t.ox - (a * t.ox + c * t.oy) + e), round(y + t.oy - (b * t.ox + d * t.oy) + f)];
}

/* ------------------------------------------------------------------ */
/* Children                                                            */
/* ------------------------------------------------------------------ */

function walkChildren(parent: Element | ShadowRoot, origin: Origin, col: Col, sink: Item[], ctx: Ctx): void {
  for (const child of childNodesOf(parent)) {
    if (ctx.truncated) break;
    if (child.nodeType === Node.TEXT_NODE) {
      for (const n of textLayers(child as Text, ctx, origin)) sink.push({ n, key: 0, order: ctx.order++ });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      walkElement(child as Element, origin, col, sink, ctx);
    }
  }
}

/** Walks the children of `el`, with its in-flow ::before / ::after temporarily turned into real nodes. */
function walkKids(el: Element | ShadowRoot, origin: Origin, col: Col, sink: Item[], ctx: Ctx): void {
  const undo = el instanceof Element ? materializePseudos(el, ctx) : null;
  try {
    walkChildren(el, origin, col, sink, ctx);
  } finally {
    undo?.();
  }
}

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

export function walkElement(el: Element, parent: Origin, col: Col, sink: Item[], ctx: Ctx): void {
  if (ctx.count >= ctx.maxNodes) {
    if (!ctx.truncated) {
      ctx.truncated = true;
      warn(ctx, `capture stopped at ${ctx.maxNodes.toLocaleString()} layers (page is very large)`);
    }
    return;
  }
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag) || el.hasAttribute('data-webframe-ui')) return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return;
  if (cs.display === 'contents') return walkKids(el, parent, col, sink, ctx);
  if (parseFloat(cs.opacity) === 0) return;

  const svgRoot = isSvgRoot(el);
  if (el.namespaceURI === SVG_NS && !svgRoot) return;

  const rect = el.getBoundingClientRect();
  const X = rect.left + ctx.originX;
  const Y = rect.top + ctx.originY;
  const W = rect.width;
  const H = rect.height;

  // A box with zero width (or height) that clips that axis shows nothing of its content (collapsed accordions, closed menus).
  if ((W === 0 && cs.overflowX !== 'visible') || (H === 0 && cs.overflowY !== 'visible')) return;
  if (!parent.t && outside(X, Y, W, H, ctx) && !(W === 0 && H === 0)) return;
  // Visually-hidden helper text (sr-only pattern)
  if (W < 2 && H < 2 && (cs.overflowX !== 'visible' || cs.clip !== 'auto')) return;

  const tf = ctx.xf.get(el);
  if (tf && Math.abs(tf.m[0] * tf.m[3] - tf.m[1] * tf.m[2]) < 1e-6) return; // scale(0) – not visible

  const hiddenSelf = cs.visibility !== 'visible';
  if (hiddenSelf && REPLACED.has(tag)) return;
  const abs = cs.position === 'absolute' || cs.position === 'fixed';
  const parentEl = el.parentElement;
  const parentCs = parentEl ? getComputedStyle(parentEl) : null;
  const key = paintKey(el, cs, parentCs, ctx);

  // Should this layer leave its DOM parent and join the paint boundary's own list?
  const hoist =
    key !== 0 &&
    sink !== col.items &&
    (key !== 0.5 || cs.position === 'fixed' || X < parent.x - 1 || Y < parent.y - 1 || X + W > parent.x + (parent.w ?? Infinity) + 1 || Y + H > parent.y + (parent.h ?? Infinity) + 1);
  const base = hoist ? col : parent;
  const rx = X - base.x;
  const ry = Y - base.y;
  const here: Origin = { x: X, y: Y, w: W, h: H, t: parent.t || !!tf };
  const emit = (n: LayerNode, order: number) => {
    if (tf) setRel(n, tf, rx, ry);
    if (hoist) {
      n.abs = true;
      col.items.push({ n, key, order });
    } else sink.push({ n, key, order });
  };

  /* ----- inline SVG ----- */
  if (svgRoot) {
    if (hiddenSelf || W <= 0 || H <= 0) return;
    const markup = serializeSvg(el as SVGSVGElement, W, H);
    if (!markup) {
      warn(ctx, 'very large inline SVG skipped');
      return;
    }
    ctx.stats.svgs++;
    ctx.count++;
    const node: SvgLayer = { type: 'svg', name: layerName(el, 'svg'), x: round(rx), y: round(ry), w: round(W), h: round(H), svg: markup };
    applyCommon(node, cs, abs);
    emit(node, ctx.order++);
    return;
  }

  const savedGradient = ctx.gradientText; // readBox may set it for `background-clip: text`
  const savedPaint = ctx.gradientPaint;
  let box = hiddenSelf ? null : readBox(el, cs, W, H, ctx);
  // <body>'s background is painted by the canvas (the root frame) – don't paint it twice.
  if (box && el === el.ownerDocument.body && canvasColor(ctx, el.ownerDocument).fromBody) {
    box = { ...box, fills: box.fills.filter((p) => p.type !== 'solid') };
  }
  const visual = box ? hasVisual(box) : false;

  // clip-path / mask-image: decorative shapes, "reveal" animations that start fully clipped
  let clipShape: ClipShape | null = null;
  let maskPaint: Paint | null = null;
  if (!hiddenSelf) {
    const shape = readClipShape(cs, W, H);
    if (shape === 'hidden') {
      ctx.gradientText = savedGradient;
      ctx.gradientPaint = savedPaint;
      return; // nothing of this element is visible
    }
    clipShape = shape;
    maskPaint = readMask(cs, W, H, ctx);
    const rawMask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
    if (!maskPaint && rawMask && rawMask !== 'none') warn(ctx, 'image masks (mask-image: url(...)) are not applied');
    if (!clipShape && cs.clipPath !== 'none') warn(ctx, 'clip-path shapes other than inset / circle / ellipse / polygon / path are not applied');
  }

  /* ----- replaced / special content ----- */
  const special = specialContent(el, tag, cs, W, H, here, ctx);

  /* ----- transparent inline wrappers are hoisted ----- */
  const inlineLike = cs.display === 'inline';
  const plainWrapper = !tf && !clipShape && !maskPaint && key === 0 && parseFloat(cs.opacity) === 1 && cs.mixBlendMode === 'normal' && cs.filter === 'none';
  if (!special && plainWrapper && (W === 0 || H === 0 || (inlineLike && !visual)) && !visual) {
    walkKids(el, parent, col, sink, ctx);
    ctx.gradientText = savedGradient;
    ctx.gradientPaint = savedPaint;
    return;
  }

  ctx.count++;
  const order = ctx.order++;

  // A stacking context or a clipping box is a paint boundary of its own.
  const boundary = createsStackingContext(el, cs, parentCs, ctx) || !!box?.clip || !!special?.clip;
  let children: LayerNode[] = [];
  if (special?.children) children = special.children;
  else if (!special?.leaf) {
    if (boundary) {
      const own = newCol(here);
      walkKids(el, here, own, own.items, ctx);
      children = finish(own.items);
    } else {
      const own: Item[] = [];
      walkKids(el, here, col, own, ctx);
      children = finish(own);
    }
  }
  ctx.gradientText = savedGradient;
  ctx.gradientPaint = savedPaint;

  // List markers
  const marker = hiddenSelf ? null : listMarker(el, cs, here, rect, ctx);

  const fills = box ? [...box.fills] : [];
  if (special?.fills) fills.push(...special.fills);
  const effectiveBox: BoxStyle | null = box ? { ...box, fills } : null;

  const bgFrames = box?.bgFrames ?? [];
  const f = frame(layerName(el, tag), rx, ry, W, H, effectiveBox, [...bgFrames, ...children, ...(marker ? [marker] : [])]);
  if (special?.stroke && !f.stroke) f.stroke = special.stroke;
  if (special?.radius && !f.radius) f.radius = special.radius;
  if (special?.clip || tag === 'input' || tag === 'textarea' || tag === 'select') f.clip = true;
  if (clipShape) f.clipShape = clipShape;
  if (maskPaint) f.mask = maskPaint;
  applyCommon(f, cs, abs);
  emit(f, order);
}

/* ------------------------------------------------------------------ */
/* Replaced elements, form controls                                    */
/* ------------------------------------------------------------------ */

interface Special {
  fills?: Paint[];
  children?: LayerNode[];
  leaf?: boolean;
  stroke?: Stroke;
  radius?: FrameNode['radius'];
  clip?: boolean;
}

function objectPos(cs: CSSStyleDeclaration): [number, number] | undefined {
  if (cs.objectFit !== 'cover') return undefined;
  const [x = '50%', y = '50%'] = cs.objectPosition.split(/\s+/);
  return fractions(x, y);
}

function fitOf(cs: CSSStyleDeclaration): 'fill' | 'fit' | 'stretch' {
  const f = cs.objectFit;
  return f === 'cover' ? 'fill' : f === 'contain' || f === 'scale-down' ? 'fit' : 'stretch';
}

/** Placeholder underneath, real pixels (a screenshot of the element) on top when we have them. */
function shotFill(el: Element, ctx: Ctx, fit: 'fill' | 'fit' | 'stretch' = 'stretch'): Paint[] {
  const id = ctx.shots.get(el);
  return id ? [PLACEHOLDER, { type: 'image', asset: id, fit }] : [PLACEHOLDER];
}

function specialContent(el: Element, tag: string, cs: CSSStyleDeclaration, W: number, H: number, here: Origin, ctx: Ctx): Special | null {
  if (tag === 'img') {
    const img = el as HTMLImageElement;
    const src = img.currentSrc || img.getAttribute('src') || '';
    ctx.stats.images++;
    if (!src || !ctx.opts.images) return { fills: [PLACEHOLDER], leaf: true };
    if (/^blob:/i.test(src) && img.complete && img.naturalWidth > 0) {
      // already decoded in the page: copy the pixels instead of re-downloading a URL that only the page can open
      try {
        const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/png');
        const id = ctx.assets.addInline({ kind: 'raster', mime: 'image/png', data: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height });
        return { fills: [{ type: 'image', asset: id, fit: fitOf(cs), pos: objectPos(cs) }], leaf: true };
      } catch {
        /* tainted – fall through to a fetch inside the page */
      }
    }
    return { fills: [{ type: 'image', asset: ctx.assets.request(src), fit: fitOf(cs), pos: objectPos(cs) }], leaf: true };
  }

  if (tag === 'canvas') {
    const canvas = el as HTMLCanvasElement;
    const shot = ctx.shots.get(el);
    if (shot) return { fills: shotFill(el, ctx), leaf: true };
    try {
      const url = canvas.toDataURL('image/png');
      const data = url.slice(url.indexOf(',') + 1);
      const id = ctx.assets.addInline({ kind: 'raster', mime: 'image/png', data, w: canvas.width, h: canvas.height });
      ctx.stats.images++;
      return { fills: [{ type: 'image', asset: id, fit: 'stretch' }], leaf: true };
    } catch {
      warn(ctx, 'canvas elements with cross-origin content became placeholders');
      return { fills: [PLACEHOLDER], leaf: true };
    }
  }

  if (tag === 'video') {
    const el2 = el as HTMLVideoElement;
    ctx.stats.images++;
    try {
      if (el2.readyState >= 2 && el2.videoWidth) {
        const c = document.createElement('canvas');
        c.width = el2.videoWidth;
        c.height = el2.videoHeight;
        c.getContext('2d')?.drawImage(el2, 0, 0);
        const url = c.toDataURL('image/jpeg', 0.85);
        const id = ctx.assets.addInline({ kind: 'raster', mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height });
        return { fills: [{ type: 'image', asset: id, fit: fitOf(cs) }], leaf: true };
      }
    } catch {
      /* tainted – fall through */
    }
    if (ctx.shots.has(el)) return { fills: shotFill(el, ctx, fitOf(cs)), leaf: true };
    if (el2.poster && ctx.opts.images) return { fills: [{ type: 'image', asset: ctx.assets.request(el2.poster), fit: fitOf(cs) }], leaf: true };
    warn(ctx, 'video elements became placeholders');
    return { fills: [PLACEHOLDER], leaf: true };
  }

  if (tag === 'iframe') return iframeContent(el as HTMLIFrameElement, cs, W, H, here, ctx);

  if (tag === 'embed' || tag === 'object') {
    if (W < 5 || H < 5) return { leaf: true };
    if (ctx.shots.has(el)) return { fills: shotFill(el, ctx), leaf: true };
    warn(ctx, 'embedded objects became placeholders');
    return { fills: [PLACEHOLDER], leaf: true };
  }

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const control = el as HTMLInputElement;
    const toggle = tag === 'input' && (control.type === 'checkbox' || control.type === 'radio') ? nativeToggle(control, cs, W, H, ctx) : null;
    if (toggle) return toggle;
    return { children: formText(control, cs, W, H, ctx), leaf: true };
  }
  return null;
}

/** Same-origin iframes are walked like any other part of the page; cross-origin ones use a screenshot. */
function iframeContent(el: HTMLIFrameElement, cs: CSSStyleDeclaration, W: number, H: number, here: Origin, ctx: Ctx): Special | null {
  if (W < 5 || H < 5) return { leaf: true }; // tracking pixels, hidden helper frames
  let doc: Document | null = null;
  try {
    doc = el.contentDocument;
  } catch {
    doc = null;
  }
  const win = el.contentWindow;
  if (doc?.documentElement && doc.body && win && ctx.depth < MAX_IFRAME_DEPTH) {
    const bl = px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const bt = px(cs.borderTopWidth) + px(cs.paddingTop);
    const saved = { x: ctx.originX, y: ctx.originY, b: ctx.bounds };
    const prepared = prepareDocument(doc, ctx);
    ctx.originX = here.x + bl;
    ctx.originY = here.y + bt;
    ctx.bounds = { w: here.x + bl + win.innerWidth, h: here.y + bt + win.innerHeight };
    ctx.depth++;
    try {
      const own = newCol(here);
      walkKids(doc.documentElement, here, own, own.items, ctx);
      const bg = canvasColor(ctx, doc).color;
      return { children: finish(own.items), fills: bg && bg.a > 0 ? [{ type: 'solid', color: bg }] : [], leaf: true, clip: true };
    } finally {
      ctx.depth--;
      prepared.restore();
      ctx.originX = saved.x;
      ctx.originY = saved.y;
      ctx.bounds = saved.b;
    }
  }
  if (ctx.shots.has(el)) return { fills: shotFill(el, ctx), leaf: true };
  warn(ctx, 'cross-origin iframes became placeholders');
  return { fills: [PLACEHOLDER], leaf: true };
}

/** Chrome's native checkbox / radio: the control has no CSS paint of its own, so draw it. */
function nativeToggle(el: HTMLInputElement, cs: CSSStyleDeclaration, W: number, H: number, ctx: Ctx): Special | null {
  if (cs.appearance === 'none' || W < 4 || H < 4) return null;
  if (px(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') return null; // author-styled
  const accent = color(ctx, cs.accentColor === 'auto' ? 'rgb(0, 117, 255)' : cs.accentColor) ?? { r: 0, g: 0.46, b: 1, a: 1 };
  const gray: RGBA = { r: 0.46, g: 0.46, b: 0.46, a: 1 };
  const white: RGBA = { r: 1, g: 1, b: 1, a: 1 };
  const radio = el.type === 'radio';
  const r = radio ? Math.min(W, H) / 2 : 2;
  const fill: RGBA = el.checked && !radio ? accent : white;
  const stroke: Stroke = { top: 1, right: 1, bottom: 1, left: 1, color: el.checked ? accent : gray };
  const children: LayerNode[] = [];
  if (el.checked) {
    ctx.count++;
    if (radio) {
      const d = Math.min(W, H) * 0.5;
      children.push({ type: 'frame', name: 'dot', x: round((W - d) / 2), y: round((H - d) / 2), w: round(d), h: round(d), radius: [d / 2, d / 2, d / 2, d / 2], fills: [{ type: 'solid', color: accent }], children: [] });
    } else {
      const s = Math.min(W, H) * 0.8;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${s}" height="${s}"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      children.push({ type: 'svg', name: 'check', x: round((W - s) / 2), y: round((H - s) / 2), w: round(s), h: round(s), svg });
    }
  }
  const radius: Special['radius'] = [r, r, r, r];
  return { fills: [{ type: 'solid', color: radio && el.checked ? white : fill }], stroke, radius, children, leaf: true };
}

function formText(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, cs: CSSStyleDeclaration, W: number, H: number, ctx: Ctx): LayerNode[] {
  let text = '';
  let useColor = color(ctx, cs.color);
  const tag = tagOf(el);
  const type = tag === 'input' ? (el as HTMLInputElement).type : tag === 'textarea' ? 'textarea' : 'select';

  if (['checkbox', 'radio', 'range', 'file', 'color', 'image', 'hidden'].includes(type)) return [];
  if (tag === 'select') {
    text = (el as HTMLSelectElement).selectedOptions[0]?.text ?? '';
  } else {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    text = field.value;
    if (type === 'password') text = '•'.repeat(text.length);
    if (!text && field.placeholder) {
      text = field.placeholder;
      useColor = color(ctx, getComputedStyle(el, '::placeholder').color) ?? useColor;
    }
  }
  if (!text) return [];

  const bl = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const bt = px(cs.borderTopWidth) + px(cs.paddingTop);
  const contentW = Math.max(0, W - bl - px(cs.borderRightWidth) - px(cs.paddingRight));
  const contentH = Math.max(0, H - bt - px(cs.borderBottomWidth) - px(cs.paddingBottom));
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lhCss = parseFloat(cs.lineHeight);
  const lh = Number.isFinite(lhCss) ? lhCss : fontSize * 1.2;
  const isButtonLike = ['button', 'submit', 'reset'].includes(type);
  const y = type === 'textarea' ? bt : bt + (contentH - lh) / 2;
  const layer: TextLayer = syntheticText(text, cs, { x: bl, y, w: contentW }, ctx, {
    color: useColor ?? undefined,
    align: isButtonLike ? 'center' : undefined,
    lineHeight: lh,
  });
  return [layer];
}

/* ------------------------------------------------------------------ */
/* ::before / ::after                                                  */
/* ------------------------------------------------------------------ */

/** Turns the CSS `content` value into text. Counters and images can't be resolved from script. */
function parseContent(content: string, quotes: string): { text: string; unsupported: boolean } {
  let text = '';
  let unsupported = false;
  const q = Array.from(quotes.matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((m) => m[1]);
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(open-quote|close-quote|no-open-quote|no-close-quote)|(counters?\([^)]*\)|url\([^)]*\)|image-set\([^)]*\)|attr\([^)]*\)|[a-z-]+\([^)]*\))/g;
  for (const m of content.matchAll(re)) {
    if (m[1] !== undefined || m[2] !== undefined) text += (m[1] ?? m[2]).replace(/\\(["'\\])/g, '$1');
    else if (m[3] === 'open-quote') text += q[0] ?? '“';
    else if (m[3] === 'close-quote') text += q[1] ?? '”';
    else if (m[4]) unsupported = true;
  }
  return { text, unsupported };
}

function pseudoHasPaint(pcs: CSSStyleDeclaration): boolean {
  if (pcs.backgroundImage !== 'none') return true;
  const bg = pcs.backgroundColor;
  if (bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg)) return true;
  if (px(pcs.borderTopWidth) > 0 && pcs.borderTopStyle !== 'none') return true;
  if (px(pcs.borderLeftWidth) > 0 && pcs.borderLeftStyle !== 'none') return true;
  if (px(pcs.borderBottomWidth) > 0 && pcs.borderBottomStyle !== 'none') return true;
  if (px(pcs.borderRightWidth) > 0 && pcs.borderRightStyle !== 'none') return true;
  return pcs.boxShadow !== 'none';
}

/**
 * Pseudo-elements can't be measured, so each visible ::before / ::after is replaced — only for the
 * duration of the walk — by a real <span> carrying the same computed style. The span then flows through
 * the normal pipeline (inline text, block boxes, absolute decorations, gradients, transforms, z-index…)
 * and measures exactly like the pseudo-element did.
 */
function materializePseudos(el: Element, ctx: Ctx): (() => void) | null {
  if (VOID.has(tagOf(el)) || el.namespaceURI === SVG_NS) return null;
  // Our own stand-in nodes are plain <span>s: a site rule like `span::after` would otherwise match them and recurse forever.
  if (el.hasAttribute('data-wf-pseudo')) return null;
  const before = el.getBoundingClientRect();
  const doc = el.ownerDocument;
  const undo: (() => void)[] = [];
  for (const pseudo of ['::before', '::after'] as const) {
    const pcs = getComputedStyle(el, pseudo);
    const content = pcs.content;
    if (!content || content === 'none' || content === 'normal' || pcs.display === 'none') continue;
    const { text, unsupported } = parseContent(content, pcs.quotes);
    if (unsupported) {
      if (/counters?\(/.test(content)) warn(ctx, 'CSS counter() numbers in ::before/::after were not captured');
      else if (/url\(|image-set/.test(content)) warn(ctx, 'images set through ::before/::after content: were not captured');
      if (!text && !pseudoHasPaint(pcs)) continue;
    }
    if (!text.trim() && !pseudoHasPaint(pcs)) continue;

    const span = doc.createElement('span');
    span.setAttribute('data-wf-pseudo', pseudo.slice(2));
    for (let i = 0; i < pcs.length; i++) {
      const name = pcs[i];
      if (name === 'content' || name.startsWith('animation') || name.startsWith('transition')) continue;
      span.style.setProperty(name, pcs.getPropertyValue(name), pcs.getPropertyPriority(name));
    }
    if (text) span.textContent = text;
    const pt = ctx.pxf.get(el)?.[pseudo === '::before' ? 'before' : 'after'];
    if (pt) ctx.xf.set(span, pt);

    const attr = pseudo === '::before' ? 'data-wf-nb' : 'data-wf-na';
    const revert = () => {
      span.remove();
      el.removeAttribute(attr);
    };
    el.setAttribute(attr, '');
    if (pseudo === '::before') el.insertBefore(span, el.firstChild);
    else el.appendChild(span);
    // Inserting a node can change `:first-child` / sibling-combinator matches. If the box moved, the swap isn't
    // layout-neutral for this element, so keep the original pseudo (and skip it) rather than measure a changed page.
    const after = el.getBoundingClientRect();
    if (Math.abs(after.width - before.width) > 0.5 || Math.abs(after.height - before.height) > 0.5) {
      revert();
      warn(ctx, 'some ::before/::after content was skipped (it changed the layout when measured)');
      continue;
    }
    undo.push(revert);
  }
  return undo.length ? () => undo.forEach((fn) => fn()) : null;
}

/* ------------------------------------------------------------------ */
/* List markers                                                        */
/* ------------------------------------------------------------------ */

function toRoman(n: number): string {
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) ((out += s), (n -= v));
  return out;
}

function listMarker(el: Element, cs: CSSStyleDeclaration, here: Origin, rect: DOMRect, ctx: Ctx): TextLayer | null {
  if (!(cs.display === 'list-item' && cs.listStyleType !== 'none' && cs.listStylePosition !== 'inside')) return null;
  const type = cs.listStyleType;
  const parent = el.parentElement;
  let n = 1;
  if (parent) {
    const items = Array.from(parent.children).filter((c) => getComputedStyle(c).display === 'list-item');
    const start = parseInt(parent.getAttribute('start') ?? '', 10);
    const reversed = parent.hasAttribute('reversed');
    const idx = items.indexOf(el);
    n = reversed ? (Number.isFinite(start) ? start : items.length) - idx : (Number.isFinite(start) ? start : 1) + idx;
  }
  let glyph: string;
  switch (type) {
    case 'disc':
      glyph = '•';
      break;
    case 'circle':
      glyph = '◦';
      break;
    case 'square':
      glyph = '▪';
      break;
    case 'decimal':
      glyph = `${n}.`;
      break;
    case 'decimal-leading-zero':
      glyph = `${String(n).padStart(2, '0')}.`;
      break;
    case 'lower-alpha':
    case 'lower-latin':
      glyph = `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`;
      break;
    case 'upper-alpha':
    case 'upper-latin':
      glyph = `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`;
      break;
    case 'lower-roman':
      glyph = `${toRoman(n)}.`;
      break;
    case 'upper-roman':
      glyph = `${toRoman(n).toUpperCase()}.`;
      break;
    default:
      glyph = '•';
  }
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lhCss = parseFloat(cs.lineHeight);
  const lh = Number.isFinite(lhCss) ? lhCss : fontSize * 1.2;
  const contentLeft = rect.left + ctx.originX + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const contentTop = rect.top + ctx.originY + px(cs.borderTopWidth) + px(cs.paddingTop);
  const boxW = fontSize * 2.5;
  const layer = syntheticText(glyph, cs, { x: contentLeft - boxW - fontSize * 0.28 - here.x, y: contentTop - here.y, w: boxW }, ctx, {
    align: 'right',
    lineHeight: lh,
  });
  layer.name = 'marker';
  return layer;
}
