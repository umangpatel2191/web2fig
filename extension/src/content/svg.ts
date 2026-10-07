/**
 * Serialises an inline <svg> into a standalone document Figma can import:
 *  - computed paint properties are baked into attributes (CSS classes won't survive),
 *  - `currentColor` is resolved,
 *  - `<use>` references to symbols elsewhere in the document are inlined.
 */
const PAINT_PROPS = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'fill-rule',
  'clip-rule',
];
const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'g']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SVG_CHARS = 600_000;

function bakeStyles(orig: Element, clone: Element): void {
  const o = [orig, ...orig.querySelectorAll('*')];
  const c = [clone, ...clone.querySelectorAll('*')];
  const n = Math.min(o.length, c.length);
  for (let i = 0; i < n; i++) {
    const tag = c[i].tagName.toLowerCase();
    const cs = getComputedStyle(o[i]);
    if (cs.display === 'none') {
      c[i].setAttribute('display', 'none');
      continue;
    }
    if (!SHAPES.has(tag) && i !== 0) continue;
    for (const prop of PAINT_PROPS) {
      if (tag === 'g' && prop !== 'opacity' && prop !== 'fill' && prop !== 'stroke') continue;
      const v = cs.getPropertyValue(prop);
      if (v && v !== 'normal') c[i].setAttribute(prop, v);
    }
  }
}

function inlineUses(svg: SVGSVGElement): void {
  for (const use of Array.from(svg.querySelectorAll('use'))) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (!href.startsWith('#')) continue;
    const id = href.slice(1);
    if (svg.querySelector(`[id="${CSS.escape(id)}"]`)) continue; // target is inside this svg already
    const target = document.getElementById(id);
    if (!target) continue;

    const x = parseFloat(use.getAttribute('x') ?? '0') || 0;
    const y = parseFloat(use.getAttribute('y') ?? '0') || 0;
    const g = document.createElementNS(SVG_NS, 'g');
    const t = use.getAttribute('transform');
    g.setAttribute('transform', `${t ? t + ' ' : ''}translate(${x} ${y})`);
    for (const a of ['fill', 'stroke', 'opacity']) {
      const v = use.getAttribute(a);
      if (v) g.setAttribute(a, v);
    }
    if (target.tagName.toLowerCase() === 'symbol') {
      const inner = document.createElementNS(SVG_NS, 'svg');
      const vb = target.getAttribute('viewBox');
      if (vb) inner.setAttribute('viewBox', vb);
      const w = use.getAttribute('width');
      const h = use.getAttribute('height');
      if (w) inner.setAttribute('width', w);
      if (h) inner.setAttribute('height', h);
      for (const child of Array.from(target.childNodes)) inner.appendChild(child.cloneNode(true));
      g.appendChild(inner);
    } else {
      g.appendChild(target.cloneNode(true));
    }
    use.replaceWith(g);
  }
}

export function serializeSvg(svg: SVGSVGElement, w: number, h: number): string | null {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  bakeStyles(svg, clone);
  inlineUses(clone);

  clone.setAttribute('xmlns', SVG_NS);
  if (!clone.getAttribute('viewBox')) {
    const bw = svg.width?.baseVal?.value || w;
    const bh = svg.height?.baseVal?.value || h;
    clone.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
  }
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.removeAttribute('style');
  clone.removeAttribute('class');

  const color = getComputedStyle(svg).color;
  const markup = new XMLSerializer().serializeToString(clone).replace(/currentColor/gi, color);
  return markup.length > MAX_SVG_CHARS ? null : markup;
}
