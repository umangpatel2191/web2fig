import type { CaptureMode, CaptureOptions, CaptureSummary } from '../../../shared/messages';
import type { CaptureFile } from '../../../shared/schema';
import { capturePage, primeLazyContent } from './capture';
import { pickElement } from './picker';
import { hideToast, pasteHint, toast } from './toast';

declare global {
  interface Window {
    __webframe?: boolean;
  }
}

const CHUNK = 6 * 1024 * 1024;

async function run(mode: CaptureMode, options: CaptureOptions): Promise<void> {
  const port = chrome.runtime.connect({ name: 'webframe-capture' });
  const progress = (stage: string, pct: number) => {
    port.postMessage({ type: 'progress', stage, pct });
    toast('progress', stage + '…', '', 0, pct);
  };
  port.onMessage.addListener((m: { type: string; copied?: boolean }) => {
    if (m.type !== 'finished') return;
    if (m.copied) toast('success', 'Copied to clipboard', pasteHint(), 6000);
    else toast('error', 'Captured, but the clipboard was blocked', 'Open the Web2Fig popup and use “Download .json”.', 8000);
  });

  try {
    let element: Element | null = null;
    if (mode === 'element') {
      element = await pickElement();
      if (!element) {
        hideToast();
        port.postMessage({ type: 'cancelled' });
        return;
      }
    }

    if (mode === 'full' && options.lazy) await primeLazyContent(progress, options.speed, hideToast);

    // Take the preview thumbnail while the page is in its final scroll position.
    let thumbnail: string | undefined;
    hideToast(); // keep our own UI out of the screenshot
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'webframe:thumbnail' })) as { ok: boolean; dataUrl?: string };
      if (res?.ok) thumbnail = res.dataUrl;
    } catch {
      /* optional */
    }

    const file: CaptureFile = await capturePage({ mode, options, element, thumbnail, progress, hideUi: hideToast });
    progress('Sending to clipboard', 0.97);

    const json = JSON.stringify(file);
    const total = Math.ceil(json.length / CHUNK);
    for (let i = 0; i < total; i++) port.postMessage({ type: 'chunk', index: i, total, data: json.slice(i * CHUNK, (i + 1) * CHUNK) });

    const summary: Omit<CaptureSummary, 'bytes' | 'copied' | 'at'> = {
      title: file.source.title,
      url: file.source.url,
      mode,
      layers: file.stats.layers,
      texts: file.stats.texts,
      images: file.stats.images,
      svgs: file.stats.svgs,
      fonts: file.fonts.length,
      warnings: file.warnings,
    };
    port.postMessage({ type: 'done', summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast('error', 'Capture failed', message, 8000);
    port.postMessage({ type: 'error', message });
  }
}

if (!window.__webframe) {
  window.__webframe = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'webframe:start') {
      sendResponse({ ok: true });
      void run(msg.mode as CaptureMode, msg.options as CaptureOptions);
    }
  });
}
