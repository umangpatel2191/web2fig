import { BRAND, logoSvg } from '../../../shared/brand';

export type ToastKind = 'progress' | 'success' | 'error';

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let timer: number | undefined;

const STYLE = `
  :host{all:initial}
  .t{display:flex;gap:12px;align-items:flex-start;width:320px;padding:12px 14px 13px;border-radius:16px;position:relative;overflow:hidden;
     font:500 13px/1.4 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;background:rgba(17,17,24,.95);backdrop-filter:blur(14px);
     box-shadow:0 14px 44px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.09);animation:in .26s cubic-bezier(.2,.9,.2,1)}
  @keyframes in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
  .mark{flex:none;width:30px;height:30px;margin-top:1px;filter:drop-shadow(0 3px 8px rgba(91,92,246,.45))}
  .mark svg{display:block;width:100%;height:100%}
  .body{flex:1;min-width:0}
  .brand{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.5);display:flex;align-items:center;gap:6px}
  .state{width:7px;height:7px;border-radius:50%;background:#8f8fff}
  .progress .state{animation:pulse 1s ease-in-out infinite}
  .success .state{background:#34d399}
  .error .state{background:#f87171}
  @keyframes pulse{50%{transform:scale(.55);opacity:.55}}
  b{display:block;font-weight:650;font-size:13.5px;margin-top:2px}
  span.d{display:block;color:rgba(255,255,255,.68);font-weight:450;margin-top:2px}
  .bar{position:absolute;left:0;bottom:0;height:3px;background:linear-gradient(90deg,#5b5cf6,#9b4df0);border-radius:0 3px 3px 0;transition:width .35s ease}
  kbd{font:inherit;font-weight:600;background:rgba(255,255,255,.16);padding:1px 6px;border-radius:5px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

function ensureRoot(): ShadowRoot {
  if (root && host?.isConnected) return root;
  host = document.createElement('div');
  host.setAttribute('data-webframe-ui', '');
  host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none';
  root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);
  return root;
}

export function toast(kind: ToastKind, title: string, detail = '', hideAfterMs = 0, pct?: number): void {
  const r = ensureRoot();
  clearTimeout(timer);
  r.innerHTML =
    `<style>${STYLE}</style><div class="t ${kind}"><div class="mark">${logoSvg(30)}</div>` +
    `<div class="body"><div class="brand"><i class="state"></i>${BRAND.name}</div><b></b><span class="d"></span></div>` +
    `${pct !== undefined ? `<div class="bar" style="width:${Math.max(3, Math.min(100, Math.round(pct * 100)))}%"></div>` : ''}</div>`;
  (r.querySelector('b') as HTMLElement).textContent = title;
  const d = r.querySelector('.d') as HTMLElement;
  if (detail) d.textContent = detail;
  else d.remove();
  if (hideAfterMs) timer = window.setTimeout(hideToast, hideAfterMs);
}

export function hideToast(): void {
  clearTimeout(timer);
  host?.remove();
  host = null;
  root = null;
}

export const pasteHint = (): string => `Open ${BRAND.name} in Figma and press ${/mac|iphone|ipad/i.test(navigator.platform) ? '⌘' : 'Ctrl'}+V`;
