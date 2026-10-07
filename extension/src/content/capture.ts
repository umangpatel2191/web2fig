import { round } from '../../../shared/css';
import type { CaptureMode, CaptureOptions, ScrollSpeed } from '../../../shared/messages';
import { MAGIC, SCHEMA_VERSION, type CaptureFile, type FrameNode, type LayerNode, type Paint } from '../../../shared/schema';
import { AssetCollector } from './assets';
import { fontUsageList, makeColorResolver, warningList, type Ctx } from './context';
import { canvasColor, prepareDocument } from './prepare';
import { assetSize, sizedSvg, svgToPng } from './style';
import { walkRoot, walkSingle } from './walker';

export type Progress = (stage: string, pct: number) => void;

const MAX_NODES = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Lazy content                                                        */
/* ------------------------------------------------------------------ */

/** Scrolls through the page so lazy images / reveal animations run, then returns to the top. */
/**
 * Scrolls the page top → bottom (and back) in small steps so lazy images load and reveal-on-scroll animations play.
 * There is deliberately no time limit: it keeps going until it reaches the real bottom and the page stops growing
 * (infinite lists are bounded by distance, not time).
 */
export async function primeLazyContent(progress: Progress, speed: ScrollSpeed = 'balanced', hideUi?: () => void): Promise<void> {
  const thorough = speed === 'thorough';
  const scroller = () => document.scrollingElement ?? document.documentElement;
  const dwell = thorough ? 650 : 320;
  const stepPx = () => Math.max(160, window.innerHeight * (thorough ? 0.33 : 0.5));
  const maxDistance = window.innerHeight * 400; // guard for endless feeds
  const needStagnant = thorough ? 3 : 2;
  let y = 0;
  let stagnant = 0;

  // Pass 1: top → bottom. The page may keep growing (lazy sections), so the bottom is re-measured every step.
  for (; y <= maxDistance; ) {
    window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
    const total = Math.max(1, scroller().scrollHeight - window.innerHeight);
    progress('Scrolling through the page', Math.min(0.2, (y / total) * 0.2));
    await settle(dwell);
    const bottom = scroller().scrollHeight - window.innerHeight;
    if (y >= bottom - 2) {
      if (++stagnant >= needStagnant) break; // at the bottom and it stopped growing
      await settle(dwell * 2);
    } else stagnant = 0;
    y = Math.min(y + stepPx(), Math.max(0, bottom));
  }

  // Dwell at the very bottom (footer reveals, final scroll-linked states), then come back up faster so
  // sections that only play when scrolled into view from below get their turn too.
  await settle(thorough ? 1200 : 500);
  for (let yy = scroller().scrollHeight; yy > 0; yy -= stepPx() * (thorough ? 1.4 : 2)) {
    window.scrollTo({ top: yy, behavior: 'instant' as ScrollBehavior });
    progress('Scrolling back up', 0.2);
    await settle(dwell * 0.5);
  }

  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  const pending = Array.from(document.images).filter((img) => !img.complete);
  if (pending.length) {
    await Promise.race([Promise.all(pending.map((img) => img.decode().catch(() => undefined))), sleep(thorough ? 8000 : 4000)]);
  }
  await settle(thorough ? 1200 : 700); // let scroll-linked / eased animations (Lenis, GSAP lerp) settle at the top
  hideUi?.();
}

/** Waits `ms`, then until running finite CSS/Web animations have finished (bounded). */
async function settle(ms: number): Promise<void> {
  await sleep(ms);
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const running = (document.getAnimations?.() ?? []).filter((a) => {
      if (a.playState !== 'running') return false;
      const t = a.effect?.getComputedTiming();
      return !!t && Number.isFinite(t.endTime as number);
    });
    if (running.length === 0) return;
    await sleep(120);
  }
}

/** Jumps finite CSS / Web animations to their end state, so reveal-on-scroll content is captured visible. */
function finishAnimations(): void {
  for (const a of document.getAnimations?.() ?? []) {
    try {
      const t = a.effect?.getComputedTiming();
      if (t && Number.isFinite(t.endTime as number) && t.direction !== 'reverse') a.finish();
    } catch {
      /* some animations can't be finished */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Post-processing                                                     */
/* ------------------------------------------------------------------ */

function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.6;
}

function isPlain(n: FrameNode): boolean {
  return !n.fills?.length && !n.stroke && !n.shadows?.length && !n.blur && !n.bgBlur && !n.blend && !n.clip && !n.rel;
}

/** Removes wrapper frames that add nothing (no styling, one child with identical bounds). */
function simplify(n: LayerNode): LayerNode {
  if (n.type !== 'frame') return n;
  n.children = n.children.map(simplify);
  for (;;) {
    if (!(isPlain(n) && n.children.length === 1)) break;
    const c = n.children[0];
    if (!(same(c.x, 0) && same(c.y, 0) && same(c.w, n.w) && same(c.h, n.h))) break;
    c.x = round(n.x + c.x);
    c.y = round(n.y + c.y);
    if (c.rel) c.rel = [c.rel[0], c.rel[1], c.rel[2], c.rel[3], round(c.rel[4] + n.x), round(c.rel[5] + n.y)];
    if (n.opacity !== undefined) c.opacity = round((c.opacity ?? 1) * n.opacity, 3);
    if (n.abs) c.abs = true;
    return c;
  }
  return n;
}

function prune(n: LayerNode, ctx: Ctx, missing: Set<string>): LayerNode | null {
  if (n.type === 'svg') return n.asset && missing.has(n.asset) ? null : n;
  if (n.type === 'text') return n;
  if (n.fills) {
    n.fills = n.fills.filter((p: Paint) => !(p.type === 'image' && missing.has(p.asset)));
    if (!n.fills.length) delete n.fills;
  }
  n.children = n.children
    .map((c) => prune(c, ctx, missing))
    .filter((c): c is LayerNode => c !== null)
    // synthetic background frames that ended up with nothing to show (e.g. `background-size: 0`)
    .filter((c) => !(c.type === 'frame' && /^background-/.test(c.name) && c.children.length === 0 && !c.fills?.length));
  return n;
}

function count(n: LayerNode): number {
  return n.type === 'frame' ? 1 + n.children.reduce((s, c) => s + count(c), 0) : 1;
}

/** Collects the asset ids that are actually referenced, so unused downloads aren't shipped. */
function referenced(n: LayerNode, out: Set<string>): void {
  if (n.type === 'svg' && n.asset) out.add(n.asset);
  if (n.type === 'frame') {
    n.fills?.forEach((p) => p.type === 'image' && out.add(p.asset));
    n.children.forEach((c) => referenced(c, out));
  }
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

function canvasBackground(ctx: Ctx): Paint[] {
  return [{ type: 'solid', color: canvasColor(ctx, document).color ?? { r: 1, g: 1, b: 1, a: 1 } }];
}

export interface CaptureArgs {
  mode: CaptureMode;
  options: CaptureOptions;
  element: Element | null;
  thumbnail?: string;
  progress: Progress;
  /** Hides the extension's own UI (toast) so it isn't part of a screenshot. */
  hideUi?: () => void;
}

export async function capturePage({ mode, options, element, thumbnail, progress, hideUi }: CaptureArgs): Promise<CaptureFile> {
  // Freeze animations so we measure final states, not mid-transition ones.
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important;scroll-behavior:auto!important}';
  document.documentElement.appendChild(freeze);
  const startX = window.scrollX;
  const startY = window.scrollY;
  // Must be undone on every exit path (including errors): it switches the page's transforms off while measuring.
  let prepared: { restore(): void } | undefined;

  try {
    progress('Reading page', 0.2);
    finishAnimations();
    await sleep(60);

    const docEl = document.documentElement;
    const assets = new AssetCollector();
    const ctx: Ctx = {
      originX: 0,
      originY: 0,
      bounds: { w: 0, h: 0 },
      opts: options,
      assets,
      fonts: new Map(),
      warnings: new Map(),
      count: 0,
      maxNodes: MAX_NODES,
      truncated: false,
      resolveColor: makeColorResolver(),
      gradientText: null,
      gradientPaint: null,
      order: 0,
      xf: new WeakMap(),
      pxf: new WeakMap(),
      shots: new WeakMap(),
      depth: 0,
      rasterSvgs: new Set(),
      jobs: [],
      stats: { texts: 0, images: 0, svgs: 0 },
      deferred: [],
    };

    // Cross-origin iframes, tainted / WebGL canvases and videos can't be read from script: screenshot them.
    if (options.images) await captureShots(ctx, mode === 'element' ? element : mode === 'visible' ? 'visible' : 'full', hideUi, progress);

    // From here to the end of the walk everything is synchronous, so the page never paints un-transformed.
    prepared = prepareDocument(document, ctx);

    let root: FrameNode;
    const title = document.title || location.hostname;

    if (mode === 'element' && element) {
      const r = element.getBoundingClientRect();
      ctx.originX = -r.left;
      ctx.originY = -r.top;
      ctx.bounds = { w: r.width, h: r.height };
      const kids = walkSingle(element, { x: 0, y: 0 }, ctx);
      root = { type: 'frame', name: elementName(element), x: 0, y: 0, w: round(r.width), h: round(r.height), clip: true, children: kids };
    } else if (mode === 'visible') {
      ctx.originX = 0;
      ctx.originY = 0;
      const w = docEl.clientWidth;
      const h = window.innerHeight;
      ctx.bounds = { w, h };
      root = {
        type: 'frame',
        name: `${location.hostname} — viewport`,
        x: 0,
        y: 0,
        w,
        h,
        clip: true,
        fills: canvasBackground(ctx),
        children: walkRoot(docEl, { x: 0, y: 0 }, ctx),
      };
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
      ctx.originX = window.scrollX;
      ctx.originY = window.scrollY;
      const w = Math.max(docEl.scrollWidth, document.body?.scrollWidth ?? 0, docEl.clientWidth);
      const h = Math.max(docEl.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight);
      ctx.bounds = { w, h };
      root = {
        type: 'frame',
        name: `${location.hostname} — ${title}`.slice(0, 80),
        x: 0,
        y: 0,
        w,
        h,
        clip: true,
        fills: canvasBackground(ctx),
        children: walkRoot(docEl, { x: 0, y: 0 }, ctx),
      };
    }
    prepared.restore();
    prepared = undefined;

    progress('Downloading images', 0.4);
    await assets.resolveAll((done, total) => progress('Downloading images', 0.4 + (done / Math.max(1, total)) * 0.45));

    progress('Preparing backgrounds', 0.86);
    for (const id of ctx.rasterSvgs) {
      const a = assets.get(id);
      if (a?.kind !== 'svg') continue;
      ctx.jobs.push(async () => {
        const nat = assetSize(a) ?? { w: 64, h: 64 };
        const png = await svgToPng(sizedSvg(a.svg, nat.w, nat.h), nat.w, nat.h, Math.min(3, 2048 / Math.max(nat.w, nat.h)));
        if (!png) return;
        assets.set(id, { kind: 'raster', mime: 'image/png', data: png.data, w: png.w, h: png.h });
        assets.natural.set(id, nat);
      });
    }
    for (const job of ctx.jobs) await job().catch(() => undefined);
    ctx.deferred.forEach((fn) => fn());

    if (assets.failed.size) ctx.warnings.set(`${assets.failed.size} image(s) could not be downloaded and were left out`, 1);

    progress('Packaging', 0.9);
    let tree = simplify(root) as FrameNode;
    tree = prune(tree, ctx, assets.failed) as FrameNode;

    const used = new Set<string>();
    referenced(tree, used);
    const outAssets: CaptureFile['assets'] = {};
    for (const id of used) {
      const a = assets.get(id);
      if (a) outAssets[id] = a;
    }

    return {
      magic: MAGIC,
      version: SCHEMA_VERSION,
      tool: { name: 'web2fig-extension', version: chrome.runtime.getManifest().version },
      source: {
        url: location.href,
        title,
        capturedAt: new Date().toISOString(),
        mode,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        dpr: window.devicePixelRatio,
      },
      thumbnail,
      root: tree,
      assets: outAssets,
      fonts: fontUsageList(ctx),
      stats: { layers: count(tree), texts: ctx.stats.texts, images: ctx.stats.images, svgs: ctx.stats.svgs },
      warnings: warningList(ctx),
    };
  } finally {
    prepared?.restore();
    freeze.remove();
    window.scrollTo({ left: startX, top: startY, behavior: 'instant' as ScrollBehavior });
  }
}

/* ------------------------------------------------------------------ */
/* Screenshots of content that can't be read from script               */
/* ------------------------------------------------------------------ */

const MAX_SHOTS = 10;

function pixelsReadable(source: CanvasImageSource): boolean {
  try {
    const t = document.createElement('canvas');
    t.width = t.height = 8;
    const g = t.getContext('2d', { willReadFrequently: true });
    if (!g) return false;
    g.drawImage(source, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data; // throws when tainted
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    return false; // fully transparent → WebGL canvas without preserveDrawingBuffer, or an empty frame
  } catch {
    return false;
  }
}

function needsShot(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'iframe') {
    try {
      return !(el as HTMLIFrameElement).contentDocument;
    } catch {
      return true;
    }
  }
  if (tag === 'canvas') return !pixelsReadable(el as HTMLCanvasElement);
  if (tag === 'video') return !pixelsReadable(el as HTMLVideoElement);
  return true; // embed / object
}

async function captureShots(ctx: Ctx, scope: Element | 'visible' | 'full' | null, hideUi: (() => void) | undefined, progress: Progress): Promise<void> {
  const wanted: { el: Element; top: number }[] = [];
  for (const el of Array.from(document.querySelectorAll('iframe,canvas,video,embed,object'))) {
    if (scope instanceof Element && !scope.contains(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || r.width < 24 || r.height < 24) continue;
    if (scope === 'visible' && (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth)) continue;
    if (!needsShot(el)) continue;
    wanted.push({ el, top: r.top + window.scrollY });
  }
  if (wanted.length === 0) return;
  wanted.sort((a, b) => a.top - b.top);

  let n = 0;
  for (const { el, top } of wanted.slice(0, MAX_SHOTS)) {
    progress('Capturing embedded content', 0.3 + (n++ / MAX_SHOTS) * 0.1);
    if (scope !== 'visible') {
      const r0 = el.getBoundingClientRect();
      if (r0.height > window.innerHeight) continue; // can't fit in one screenshot
      window.scrollTo({ top: Math.max(0, top - Math.max(0, (window.innerHeight - r0.height) / 2)), behavior: 'instant' as ScrollBehavior });
    }
    hideUi?.();
    await sleep(260);
    const r = el.getBoundingClientRect();
    if (r.top < -1 || r.bottom > window.innerHeight + 1 || r.left < -1 || r.right > window.innerWidth + 1) continue;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'webframe:captureRegion',
        rect: { x: Math.max(0, r.left), y: Math.max(0, r.top), w: r.width, h: r.height },
        dpr: window.devicePixelRatio || 1,
      })) as { ok: true; data: string; w: number; h: number } | { ok: false } | undefined;
      if (res?.ok) ctx.shots.set(el, ctx.assets.addInline({ kind: 'raster', mime: 'image/png', data: res.data, w: res.w, h: res.h }));
    } catch {
      /* quota / permission – keep the placeholder */
    }
    await sleep(520); // captureVisibleTab is limited to ~2 calls per second
  }
}

function elementName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList)[0];
  return el.id ? `${tag}#${el.id}` : cls ? `${tag}.${cls}` : tag;
}
