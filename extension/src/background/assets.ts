import { blobToAsset, toBase64 } from '../imageAsset';
import type { Asset } from '../../../shared/schema';

const MAX_DIM = 2048;

/**
 * Downloads an image with the extension's privileges (no CORS) and normalises it for Figma.
 * blob: URLs only exist inside the page that made them, so those are read by the content script instead.
 */
export async function fetchAsset(url: string, pageUrl?: string): Promise<Asset> {
  if (/^blob:/i.test(url)) throw new Error('blob URLs are read inside the page');
  let res = await fetch(url, { credentials: 'include' });
  // Many image servers refuse "hotlinking": they answer 403 unless the request names the website as its Referer.
  // A browser tab sends that automatically; this background fetch does not, so send the page's address for that host and retry.
  if ((res.status === 401 || res.status === 403) && pageUrl && (await sendPageReferer(url, pageUrl))) res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return blobToAsset(await res.blob(), url);
}

const refererRules = new Map<string, string>(); // image host -> referer already set for it

function ruleIdFor(host: string): number {
  let h = 7;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 1_000_000) + 1;
}

/** Makes this extension's own requests to `imageUrl`'s host carry the page as Referer (nothing else is changed). */
async function sendPageReferer(imageUrl: string, pageUrl: string): Promise<boolean> {
  try {
    const host = new URL(imageUrl).hostname;
    const referer = new URL(pageUrl).origin + '/';
    if (refererRules.get(host) === referer) return true;
    const id = ruleIdFor(host);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: 'referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: referer }] },
          condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST] },
        },
      ],
    });
    refererRules.set(host, referer);
    return true;
  } catch {
    return false;
  }
}

/** Removes the Referer rules (called when a new capture starts, so nothing lingers between captures). */
export async function clearRefererRules(): Promise<void> {
  refererRules.clear();
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
  } catch {
    /* nothing to clear */
  }
}

/** Crops a rectangle (CSS px of the visible viewport) out of a full-tab screenshot. */
export async function cropScreenshot(dataUrl: string, rect: { x: number; y: number; w: number; h: number }, dpr: number): Promise<{ data: string; w: number; h: number }> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.max(1, Math.min(bmp.width - sx, Math.round(rect.w * dpr)));
    const sh = Math.max(1, Math.min(bmp.height - sy, Math.round(rect.h * dpr)));
    const scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')?.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/png' });
    return { data: toBase64(await out.arrayBuffer()), w, h };
  } finally {
    bmp.close();
  }
}

/** Downscales a screenshot to a small JPEG used for the plugin preview. */
export async function makeThumbnail(dataUrl: string, maxW = 520): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxW / bmp.width);
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return `data:image/jpeg;base64,${toBase64(await out.arrayBuffer())}`;
}
