/**
 * Element picker. Everything lives in a closed shadow root so the host page's CSS can't
 * affect it, and it can't affect the page.
 */
export function pickElement(): Promise<Element | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('data-webframe-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .box{position:fixed;pointer-events:none;border:2px solid #7c2b33;background:rgba(124,43,51,.12);border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.5);
             transition:all 60ms ease-out;box-sizing:border-box}
        .tag{position:fixed;pointer-events:none;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:linear-gradient(135deg,#7c2b33,#b9505a);
             padding:4px 7px;border-radius:5px;white-space:nowrap;box-shadow:0 4px 12px rgba(91,92,246,.4)}
        .hint{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;
              font:500 13px/1 "Inter",system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:rgba(17,17,24,.94);
              padding:12px 16px;border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.09);pointer-events:none}
        kbd{font:inherit;background:rgba(255,255,255,.16);padding:3px 6px;border-radius:5px}
      </style>
      <div class="box" hidden></div><div class="tag" hidden></div>
      <div class="hint">Web2Fig · click an element to capture it <kbd>↑</kbd> parent <kbd>↓</kbd> child <kbd>Esc</kbd> cancel</div>`;
    const box = shadow.querySelector('.box') as HTMLElement;
    const tag = shadow.querySelector('.tag') as HTMLElement;
    document.documentElement.appendChild(host);

    let target: Element | null = null;
    const stack: Element[] = [];

    const label = (el: Element) => {
      const c = el.classList[0];
      return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : c ? `.${c}` : '');
    };
    const draw = () => {
      if (!target) return;
      const r = target.getBoundingClientRect();
      box.hidden = tag.hidden = false;
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const t = Math.max(4, r.top - 24);
      Object.assign(tag.style, { left: `${Math.max(4, r.left)}px`, top: `${t}px` });
      tag.textContent = `${label(target)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    };
    const pointed = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el !== document.documentElement && el !== host ? el : null;
    };

    const finish = (el: Element | null) => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', draw, true);
      host.remove();
      // let the overlay disappear before the screenshot / measurement
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(el)));
    };
    const onMove = (e: MouseEvent) => {
      const el = pointed(e);
      if (el && el !== target) {
        target = el;
        stack.length = 0;
        draw();
      }
    };
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e: MouseEvent) => {
      swallow(e);
      finish(target ?? pointed(e));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        swallow(e);
        finish(null);
      } else if (e.key === 'ArrowUp' && target?.parentElement && target.parentElement !== document.documentElement) {
        swallow(e);
        stack.push(target);
        target = target.parentElement;
        draw();
      } else if (e.key === 'ArrowDown' && stack.length) {
        swallow(e);
        target = stack.pop() ?? target;
        draw();
      } else if (e.key === 'Enter' && target) {
        swallow(e);
        finish(target);
      }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', draw, true);
  });
}
