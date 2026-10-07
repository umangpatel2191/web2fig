import type { Asset } from '../../shared/schema';

const MAX_DIM = 2048;
const MAX_RAW_BYTES = 12 * 1024 * 1024;
const PASSTHROUGH_BYTES = 3 * 1024 * 1024;

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Normalises downloaded image bytes into something Figma can ingest: PNG/JPEG up to 2048px, or SVG as text.
 * Used by the background worker (normal URLs) and by the content script (blob:/data: URLs only the page can read).
 */
export async function blobToAsset(blob: Blob, url: string): Promise<Asset> {
  if (blob.size > MAX_RAW_BYTES) throw new Error('image too large');
  const type = (blob.type || '').toLowerCase();

  if (type.includes('svg') || /\.svg(\?|#|$)/i.test(url)) {
    return { kind: 'svg', svg: await blob.text() };
  }

  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const native = type === 'image/png' || type === 'image/jpeg';
    if (scale === 1 && native && blob.size <= PASSTHROUGH_BYTES) {
      return { kind: 'raster', mime: type, data: toBase64(await blob.arrayBuffer()), w, h };
    }
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bmp, 0, 0, w, h);
    const mime = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const out = await canvas.convertToBlob({ type: mime, quality: 0.92 });
    return { kind: 'raster', mime, data: toBase64(await out.arrayBuffer()), w, h };
  } finally {
    bmp.close();
  }
}
