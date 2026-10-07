import { blobToAsset } from '../imageAsset';
import type { Asset } from '../../../shared/schema';

const CONCURRENCY = 6;
/** Total base64 budget for one capture. Keeps the clipboard payload sane. */
const MAX_TOTAL_CHARS = 48 * 1024 * 1024;

interface Job {
  id: string;
  url: string;
}

/**
 * Collects image URLs while walking the DOM, then downloads them through the background
 * worker (which is exempt from the page's CORS rules thanks to host permissions).
 */
export class AssetCollector {
  private ids = new Map<string, string>();
  private queue: Job[] = [];
  private counter = 0;
  private used = 0;
  readonly resolved: Record<string, Asset> = {};
  readonly failed = new Set<string>();

  request(url: string): string {
    let abs = url;
    try {
      abs = new URL(url, document.baseURI).href;
    } catch {
      /* keep as is */
    }
    let id = this.ids.get(abs);
    if (!id) {
      id = `a${this.counter++}`;
      this.ids.set(abs, id);
      this.queue.push({ id, url: abs });
    }
    return id;
  }

  /** Register an asset we already have (canvas / video frames). */
  addInline(asset: Asset): string {
    const id = `a${this.counter++}`;
    this.resolved[id] = asset;
    this.used += asset.kind === 'raster' ? asset.data.length : asset.svg.length;
    return id;
  }

  /** Natural CSS size of assets whose stored pixels were re-rendered at a different scale. */
  readonly natural = new Map<string, { w: number; h: number }>();

  /** Reserve an id whose content is produced later (rasterised tiles). */
  reserve(): string {
    return `a${this.counter++}`;
  }

  set(id: string, asset: Asset): void {
    this.resolved[id] = asset;
  }

  get(id: string): Asset | undefined {
    return this.resolved[id];
  }

  get pending(): number {
    return this.queue.length;
  }

  async resolveAll(onProgress: (done: number, total: number) => void): Promise<void> {
    const jobs = this.queue.splice(0);
    const total = jobs.length;
    let done = 0;
    const worker = async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        try {
          if (this.used > MAX_TOTAL_CHARS) throw new Error('budget');
          if (/^(blob|data):/i.test(job.url)) {
            // only the page can read blob: URLs it created; data: URLs need no network at all
            const asset = await blobToAsset(await (await fetch(job.url)).blob(), job.url);
            this.resolved[job.id] = asset;
            this.used += asset.kind === 'raster' ? asset.data.length : asset.svg.length;
            onProgress(++done, total);
            continue;
          }
          const res = (await chrome.runtime.sendMessage({ type: 'webframe:fetchAsset', url: job.url })) as
            | { ok: true; asset: Asset }
            | { ok: false; error: string }
            | undefined;
          if (!res || !res.ok) throw new Error(res && !res.ok ? res.error : 'no response');
          this.resolved[job.id] = res.asset;
          this.used += res.asset.kind === 'raster' ? res.asset.data.length : res.asset.svg.length;
        } catch {
          this.failed.add(job.id);
        }
        onProgress(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  }
}
