/**
 * QA only: runs the real capture pipeline inside a normal page (no extension needed) and exposes helpers
 * to the test pages:  window.__capture(mode, opts) → CaptureFile,  window.__replay(file) → DOM replica.
 */
import { DEFAULT_CAPTURE_OPTIONS } from '../shared/messages';
import type { Asset } from '../shared/schema';
import { capturePage, primeLazyContent } from '../extension/src/content/capture';
import { renderCapture } from './render';

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fetchAsset(url: string): Promise<Asset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  if (blob.type.includes('svg') || /\.svg(\?|$)/.test(url)) return { kind: 'svg', svg: await blob.text() };
  const bmp = await createImageBitmap(blob);
  const asset: Asset = { kind: 'raster', mime: blob.type || 'image/png', data: b64(await blob.arrayBuffer()), w: bmp.width, h: bmp.height };
  bmp.close();
  return asset;
}

(window as unknown as { chrome: unknown }).chrome = {
  runtime: {
    getManifest: () => ({ version: 'qa' }),
    sendMessage: async (msg: { type: string; url?: string }) => {
      if (msg.type === 'webframe:fetchAsset') {
        try {
          return { ok: true, asset: await fetchAsset(msg.url as string) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      return { ok: false };
    },
  },
};

const w = window as unknown as Record<string, unknown>;
w.__capture = async (mode: 'full' | 'visible' | 'element' = 'full', opts: Partial<typeof DEFAULT_CAPTURE_OPTIONS> = {}, selector?: string) => {
  const element = selector ? document.querySelector(selector) : null;
  const file = await capturePage({ mode, options: { ...DEFAULT_CAPTURE_OPTIONS, ...opts }, element, progress: () => undefined });
  w.__last = file;
  return file;
};
w.__replay = (file: Parameters<typeof renderCapture>[0]) => {
  document.getElementById('wf-replay')?.remove();
  const host = document.createElement('div');
  host.id = 'wf-replay';
  host.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483000;background:#fff';
  host.appendChild(renderCapture(file));
  document.body.appendChild(host);
  return file.root.h;
};
w.__summary = () => {
  const f = w.__last as import('../shared/schema').CaptureFile;
  return { stats: f.stats, warnings: f.warnings, fonts: f.fonts.map((x) => x.family) };
};

w.__prime = (speed: 'balanced' | 'thorough' = 'balanced') => primeLazyContent(() => undefined, speed);
