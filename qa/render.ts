/**
 * QA only: redraws a CaptureFile as absolutely-positioned HTML, the way Figma would lay the layers out
 * (parent-relative x/y, parent-relative transforms, children stacked in array order). Comparing a screenshot
 * of this against the original page shows geometry, paint-order, text and background mistakes.
 */
import type { Asset, CaptureFile, FrameNode, LayerNode, Paint, RGBA, TextLayer } from '../shared/schema';

const rgba = (c: RGBA) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

function assetUrl(a: Asset | undefined): string | null {
  if (!a) return null;
  if (a.kind === 'raster') return `data:${a.mime};base64,${a.data}`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(a.svg)}`;
}

function gradientCss(p: Paint, w: number, h: number): string | null {
  if (p.type === 'linear') return `linear-gradient(${p.angle}deg,${p.stops.map((s) => `${rgba(s.color)} ${s.pos * 100}%`).join(',')})`;
  if (p.type === 'radial') return `radial-gradient(${p.rx}px ${p.ry}px at ${p.cx}px ${p.cy}px,${p.stops.map((s) => `${rgba(s.color)} ${s.pos * 100}%`).join(',')})`;
  void w;
  void h;
  return null;
}

function paintLayers(fills: Paint[], file: CaptureFile, w: number, h: number): { bg: string[]; size: string[]; repeat: string[]; color?: string } {
  const out = { bg: [] as string[], size: [] as string[], repeat: [] as string[], color: undefined as string | undefined };
  // CSS lists top → bottom, Figma fills bottom → top.
  for (const p of [...fills].reverse()) {
    if (p.type === 'solid') {
      if (!out.color) out.color = rgba(p.color);
      else {
        out.bg.push(`linear-gradient(${rgba(p.color)},${rgba(p.color)})`);
        out.size.push('100% 100%');
        out.repeat.push('no-repeat');
      }
    } else if (p.type === 'image') {
      const url = assetUrl(file.assets[p.asset]);
      if (!url) continue;
      out.bg.push(`url("${url}")`);
      if (p.fit === 'tile') {
        out.size.push(`${p.tile?.w ?? 'auto'}px ${p.tile?.h ?? 'auto'}px`);
        out.repeat.push('repeat');
      } else {
        out.size.push(p.fit === 'fill' ? 'cover' : p.fit === 'fit' ? 'contain' : '100% 100%');
        out.repeat.push('no-repeat');
      }
    } else {
      const g = gradientCss(p, w, h);
      if (g) {
        out.bg.push(g);
        out.size.push('100% 100%');
        out.repeat.push('no-repeat');
      }
    }
  }
  return out;
}

function place(el: HTMLElement, n: LayerNode): void {
  el.style.position = 'absolute';
  el.style.boxSizing = 'border-box';
  el.style.margin = '0';
  el.style.width = `${n.w}px`;
  el.style.height = `${n.h}px`;
  if (n.rel) {
    el.style.left = '0';
    el.style.top = '0';
    el.style.transformOrigin = '0 0';
    el.style.transform = `matrix(${n.rel.join(',')})`;
  } else {
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
  }
  if (n.opacity !== undefined) el.style.opacity = String(n.opacity);
}

function drawText(n: TextLayer): HTMLElement {
  const el = document.createElement('div');
  place(el, n);
  el.style.width = 'auto';
  el.style.height = `${n.h}px`;
  el.style.whiteSpace = 'pre';
  el.style.font = `${n.font.italic ? 'italic ' : ''}${n.font.weight} ${n.font.size}px/${n.font.lineHeight}px ${n.font.families.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(',')}`;
  el.style.letterSpacing = `${n.font.letterSpacing}px`;
  el.style.color = rgba(n.color);
  el.style.textDecoration = n.font.decoration === 'none' ? 'none' : n.font.decoration;
  el.style.textAlign = n.font.align;
  if (n.font.align !== 'left') el.style.width = `${n.w}px`;
  el.textContent = n.text;
  el.title = n.text;
  return el;
}

function draw(n: LayerNode, file: CaptureFile): HTMLElement {
  if (n.type === 'text') return drawText(n);
  if (n.type === 'svg') {
    const el = document.createElement('div');
    place(el, n);
    el.innerHTML = n.svg ?? '';
    return el;
  }
  const f = n as FrameNode;
  const el = document.createElement('div');
  place(el, f);
  el.title = f.name;
  if (f.clip) el.style.overflow = 'hidden';
  const layers = paintLayers(f.fills ?? [], file, f.w, f.h);
  if (layers.color) el.style.backgroundColor = layers.color;
  if (layers.bg.length) {
    el.style.backgroundImage = layers.bg.join(',');
    el.style.backgroundSize = layers.size.join(',');
    el.style.backgroundRepeat = layers.repeat.join(',');
    el.style.backgroundPosition = 'center';
  }
  if (f.radius) el.style.borderRadius = f.radius.map((r) => `${r}px`).join(' ');
  if (f.stroke) {
    const s = f.stroke;
    el.style.borderStyle = s.dash ?? 'solid';
    el.style.borderColor = rgba(s.color);
    el.style.borderWidth = `${s.top}px ${s.right}px ${s.bottom}px ${s.left}px`;
  }
  if (f.shadows?.length) el.style.boxShadow = f.shadows.map((s) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${rgba(s.color)}`).join(',');
  for (const c of f.children) el.appendChild(draw(c, file));
  return el;
}

export function renderCapture(file: CaptureFile): HTMLElement {
  const root = draw(file.root, file);
  root.style.left = '0';
  root.style.top = '0';
  return root;
}
