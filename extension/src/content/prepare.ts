import { color, type Ctx, type ElementTransform } from './context';

/**
 * Everything that has to happen to a document before it is measured, and undone afterwards:
 *
 *  1. Record every element's own CSS transform (and its pseudo-elements').
 *  2. Switch transforms off, so `getBoundingClientRect()` / `Range` rects return the *layout* geometry.
 *     Each frame is then placed untransformed and gets its transform as a Figma `relativeTransform`
 *     — exactly how the browser composes nested transforms, so rotated / scaled / flipped content
 *     (and everything inside it) lands in the right place instead of in a distorted bounding box.
 *  3. Hide pseudo-elements that are re-created as real nodes (see walker `materializePseudos`).
 */
const OVERRIDE_CSS =
  '*,*::before,*::after{transform:none!important;translate:none!important;rotate:none!important;scale:none!important}' +
  '[data-wf-nb]::before{content:none!important}[data-wf-na]::after{content:none!important}' +
  // The temporary nodes standing in for pseudo-elements must never grow pseudo-elements of their own
  '[data-wf-pseudo]::before,[data-wf-pseudo]::after{content:none!important}';

const parse = (v: string) => parseFloat(v) || 0;

export function composeTransform(cs: CSSStyleDeclaration): ElementTransform | null {
  const hasT = cs.transform !== 'none' && cs.transform !== '';
  const tr = cs.translate && cs.translate !== 'none' ? cs.translate : '';
  const ro = cs.rotate && cs.rotate !== 'none' ? cs.rotate : '';
  const sc = cs.scale && cs.scale !== 'none' ? cs.scale : '';
  if (!hasT && !tr && !ro && !sc) return null;

  let m = new DOMMatrix();
  if (tr) {
    const [x = '0', y = '0'] = tr.split(/\s+/);
    m = m.translate(parse(x), parse(y));
  }
  if (ro) {
    const toks = ro.split(/\s+/);
    m = m.rotate(parse(toks[toks.length - 1]));
  }
  if (sc) {
    const [sx = '1', sy = sx] = sc.split(/\s+/);
    m = m.scale(parse(sx) || 1, parse(sy) || 1);
  }
  if (hasT) {
    try {
      m = m.multiply(new DOMMatrix(cs.transform));
    } catch {
      /* unparsable – ignore */
    }
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  if (near(m.a, 1) && near(m.b, 0) && near(m.c, 0) && near(m.d, 1) && near(m.e, 0) && near(m.f, 0)) return null;
  const [ox = '0', oy = '0'] = cs.transformOrigin.split(/\s+/);
  return { m: [m.a, m.b, m.c, m.d, m.e, m.f], ox: parse(ox), oy: parse(oy) };
}

function eachElement(root: ParentNode, fn: (el: Element) => void, roots: ShadowRoot[]): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    // Elements inside an <svg> are serialised as one unit, their transforms are baked into the markup.
    if (el.namespaceURI === 'http://www.w3.org/2000/svg' && el.tagName.toLowerCase() !== 'svg') continue;
    fn(el);
    if (el.shadowRoot) {
      roots.push(el.shadowRoot);
      eachElement(el.shadowRoot, fn, roots);
    }
  }
}

export interface Prepared {
  restore(): void;
}

export function prepareDocument(doc: Document, ctx: Ctx): Prepared {
  const win = doc.defaultView ?? window;
  const shadowRoots: ShadowRoot[] = [];
  eachElement(
    doc,
    (el) => {
      const cs = win.getComputedStyle(el);
      const t = composeTransform(cs);
      if (t) ctx.xf.set(el, t);
      for (const pseudo of ['::before', '::after'] as const) {
        const pcs = win.getComputedStyle(el, pseudo);
        const c = pcs.content;
        if (!c || c === 'none' || c === 'normal') continue;
        const pt = composeTransform(pcs);
        if (!pt) continue;
        const rec = ctx.pxf.get(el) ?? {};
        rec[pseudo === '::before' ? 'before' : 'after'] = pt;
        ctx.pxf.set(el, rec);
      }
    },
    shadowRoots,
  );

  const styles: HTMLStyleElement[] = [];
  const inject = (parent: Node) => {
    const style = doc.createElement('style');
    style.setAttribute('data-webframe-ui', '');
    style.textContent = OVERRIDE_CSS;
    parent.appendChild(style);
    styles.push(style);
  };
  inject(doc.head ?? doc.documentElement);
  for (const r of shadowRoots) inject(r);

  return {
    restore() {
      for (const s of styles) s.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Stacking                                                            */
/* ------------------------------------------------------------------ */

const FLEX_OR_GRID = /flex|grid/;

/** Does this element establish a CSS stacking context? (CSS 2.1 App. E + the modern additions.) */
export function createsStackingContext(el: Element, cs: CSSStyleDeclaration, parentCs: CSSStyleDeclaration | null, ctx: Ctx): boolean {
  const pos = cs.position;
  if (pos === 'fixed' || pos === 'sticky') return true;
  const hasZ = cs.zIndex !== 'auto';
  if (hasZ && (pos === 'absolute' || pos === 'relative')) return true;
  if (hasZ && parentCs && FLEX_OR_GRID.test(parentCs.display)) return true;
  if (parseFloat(cs.opacity) < 1) return true;
  if (ctx.xf.has(el)) return true;
  if (cs.filter !== 'none' || cs.perspective !== 'none' || cs.clipPath !== 'none') return true;
  const bf = cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter');
  if (bf && bf !== 'none') return true;
  const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
  if (mask && mask !== 'none') return true;
  if (cs.mixBlendMode !== 'normal' || cs.isolation === 'isolate') return true;
  if (/transform|opacity|filter|perspective|clip-path|mask|isolation/.test(cs.willChange)) return true;
  if (/layout|paint|strict|content/.test(cs.getPropertyValue('contain'))) return true;
  const ct = cs.getPropertyValue('container-type');
  return !!ct && ct !== 'normal';
}

/**
 * Paint phase of an element inside its stacking context:
 *  negative z-index < 0 (behind everything)  ·  0 = in-flow content  ·  0.5 = positioned / z-index:0 contexts
 *  ·  positive z-index (in front).  Ties are resolved by tree order.
 */
export function paintKey(el: Element, cs: CSSStyleDeclaration, parentCs: CSSStyleDeclaration | null, ctx: Ctx): number {
  const positioned = cs.position !== 'static';
  const flexItem = !!parentCs && FLEX_OR_GRID.test(parentCs.display);
  const z = cs.zIndex === 'auto' ? NaN : parseInt(cs.zIndex, 10);
  if ((positioned || flexItem) && Number.isFinite(z) && z !== 0) return z;
  if (positioned || (flexItem && Number.isFinite(z))) return 0.5;
  return createsStackingContext(el, cs, parentCs, ctx) ? 0.5 : 0;
}

/** The page background that the canvas (and therefore the root frame) paints. */
export function canvasColor(ctx: Ctx, doc: Document): { color: ReturnType<typeof color>; fromBody: boolean } {
  const win = doc.defaultView ?? window;
  const html = color(ctx, win.getComputedStyle(doc.documentElement).backgroundColor);
  if (html && html.a > 0) return { color: html, fromBody: false };
  const body = doc.body ? color(ctx, win.getComputedStyle(doc.body).backgroundColor) : null;
  if (body && body.a > 0) return { color: body, fromBody: true };
  return { color: { r: 1, g: 1, b: 1, a: 1 }, fromBody: false };
}
