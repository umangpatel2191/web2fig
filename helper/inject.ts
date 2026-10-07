/**
 * Runs inside the page that the Web2Fig helper opened in Chrome. It is the same capture engine as the extension,
 * with the few `chrome.*` calls it makes answered by the helper (Node) instead of the extension's background worker.
 */
import { DEFAULT_CAPTURE_OPTIONS, type CaptureOptions } from '../shared/messages';
import { blobToAsset } from '../extension/src/imageAsset';
import { capturePage, primeLazyContent } from '../extension/src/content/capture';

interface Bridge {
  __w2fFetch(url: string): Promise<{ ok: true; b64: string; type: string } | { ok: false; error: string }>;
  __w2fShot(rect: { x: number; y: number; w: number; h: number }): Promise<{ ok: true; b64: string } | { ok: false }>;
  __w2fProgress(stage: string, pct: number): void;
}
const bridge = window as unknown as Bridge & { chrome: unknown; __w2fRun: unknown };

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

bridge.chrome = {
  runtime: {
    getManifest: () => ({ version: 'helper' }),
    sendMessage: async (msg: { type: string; url?: string; rect?: { x: number; y: number; w: number; h: number }; dpr?: number }) => {
      if (msg.type === 'webframe:fetchAsset' && msg.url) {
        const res = await bridge.__w2fFetch(msg.url);
        if (!res.ok) return { ok: false, error: res.error };
        try {
          const asset = await blobToAsset(new Blob([fromBase64(res.b64) as BlobPart], { type: res.type }), msg.url);
          return { ok: true, asset };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }
      if (msg.type === 'webframe:captureRegion' && msg.rect) {
        // rect is relative to the viewport; the helper screenshots in document coordinates
        const shot = await bridge.__w2fShot({ x: msg.rect.x + window.scrollX, y: msg.rect.y + window.scrollY, w: msg.rect.w, h: msg.rect.h });
        if (!shot.ok) return { ok: false };
        const img = new Image();
        img.src = `data:image/png;base64,${shot.b64}`;
        await img.decode();
        const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/png');
        return { ok: true, data: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height };
      }
      return { ok: false };
    },
  },
};

bridge.__w2fRun = async (args: { options: Partial<CaptureOptions>; thumbnail?: string }): Promise<string> => {
  const options: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...args.options };
  const progress = (stage: string, pct: number) => bridge.__w2fProgress(stage, pct);
  if (options.lazy) await primeLazyContent(progress, options.speed);
  const file = await capturePage({ mode: 'full', options, element: null, thumbnail: args.thumbnail, progress });
  return JSON.stringify(file);
};
