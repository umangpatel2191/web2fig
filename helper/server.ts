/**
 * Web2Fig helper: lets the Figma plugin turn a pasted URL into a capture.
 * It drives a hidden Chrome, runs the same capture engine as the extension, and returns the result.
 *
 * Two ways to run it:
 *  - on your own computer (default): listens on localhost only, uses your installed Chrome;
 *  - hosted (WEB2FIG_PUBLIC=1, e.g. a Hugging Face Space): listens on every interface, downloads its own Chrome if the
 *    machine has none, refuses links to private networks, and rate-limits each visitor.
 * In both cases requests that come from ordinary web pages are refused: only the Figma plugin (origin "null") may call it.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { Browser as BrowserKind, computeExecutablePath, detectBrowserPlatform, install, resolveBuildId } from '@puppeteer/browsers';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { assertPublicUrl, isPrivateAddress } from './safety';

const PUBLIC = process.env.WEB2FIG_PUBLIC === '1';
const PORT = Number(process.env.PORT || process.env.WEB2FIG_PORT) || 5810;
const VERSION = '0.2.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const INJECT = fs.readFileSync(path.join(here, 'inject.js'), 'utf8');

const LIMITS = {
  /** captures per visitor per hour (a responsive capture counts as 3) */
  perHour: Number(process.env.WEB2FIG_RATE_PER_HOUR) || 8,
  /** captures waiting in the queue, all visitors together */
  queue: Number(process.env.WEB2FIG_QUEUE) || 6,
  /** hard cap for one capture */
  jobMs: Number(process.env.WEB2FIG_MAX_JOB_MS) || 4 * 60_000,
  /** largest result we will send back */
  resultBytes: 60 * 1024 * 1024,
};

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  if (process.env.WEB2FIG_NO_SYSTEM_CHROME === '1') return null; // used to test the download path
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

type ChromeState = 'starting' | 'downloading' | 'ready' | 'failed';
let chromeState: ChromeState = 'starting';
let chromeError = '';
let chromeReady: Promise<string> | null = null;

/** Finds Chrome, or downloads "Chrome for Testing" (once) when the machine has none. */
function ensureChrome(): Promise<string> {
  if (chromeReady) return chromeReady;
  chromeReady = (async () => {
    const found = findChrome();
    if (found) {
      chromeState = 'ready';
      return found;
    }
    chromeState = 'downloading';
    console.log('  No Chrome found: downloading one (first start only, about a minute)…');
    try {
      const platform = detectBrowserPlatform();
      if (!platform) throw new Error('unsupported platform');
      const cacheDir = process.env.WEB2FIG_CACHE || path.join(os.tmpdir(), 'web2fig-chrome');
      const buildId = await resolveBuildId(BrowserKind.CHROME, platform, 'stable');
      const executablePath = computeExecutablePath({ browser: BrowserKind.CHROME, buildId, cacheDir });
      if (!fs.existsSync(executablePath)) await install({ browser: BrowserKind.CHROME, buildId, cacheDir });
      chromeState = 'ready';
      console.log(`  Chrome ready: ${executablePath}`);
      return executablePath;
    } catch (e) {
      chromeState = 'failed';
      chromeError = e instanceof Error ? e.message : String(e);
      chromeReady = null; // allow a retry on the next request
      throw new Error(`Could not get a Chrome browser: ${chromeError}`);
    }
  })();
  chromeReady.catch(() => undefined);
  return chromeReady;
}

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (browserPromise) return browserPromise;
  browserPromise = ensureChrome()
    .then((executablePath) =>
      puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--hide-scrollbars',
          '--force-color-profile=srgb',
          '--disable-blink-features=AutomationControlled',
          '--lang=en-US',
        ],
        defaultViewport: null,
      }),
    )
    .then((b) => {
      b.on('disconnected', () => (browserPromise = null));
      return b;
    });
  browserPromise.catch(() => (browserPromise = null));
  return browserPromise;
}

/* ------------------------------------------------------------------ */
/* Fetching assets safely                                              */
/* ------------------------------------------------------------------ */

/** fetch() that re-checks every redirect hop. */
async function safeFetch(url: string, headers: Record<string, string>): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (PUBLIC) await assertPublicUrl(current);
    const res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

interface JobRequest {
  url: string;
  width: number;
  height: number;
  lazy: boolean;
  speed: 'balanced' | 'thorough';
  images: boolean;
  responsive: boolean;
  waitMs: number;
  dismissBanners: boolean;
}
interface Job {
  id: string;
  client: string;
  req: JobRequest;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  stage: string;
  pct: number;
  error?: string;
  result?: string;
  pages: Page[];
  cancelled: boolean;
  startedAt: number;
}
const jobs = new Map<string, Job>();
let chain: Promise<unknown> = Promise.resolve(); // one capture at a time
let waiting = 0;
const history = new Map<string, number[]>(); // visitor → timestamps of recent captures

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

const BANNER_SCRIPT = `(() => {
  const yes = /^(accept( all( cookies)?)?|agree|i agree|allow( all)?|got it|ok(ay)?|continue|accept cookies|reject all|decline)$/i;
  const selectors = ['#onetrust-accept-btn-handler','#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll','.cc-allow','.cc-dismiss','[data-testid="cookie-policy-manage-dialog-accept-button"]','button[aria-label*="accept" i]'];
  for (const s of selectors) { const el = document.querySelector(s); if (el) { el.click(); return true; } }
  const boxes = [...document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i]')];
  for (const box of boxes) {
    for (const b of box.querySelectorAll('button,a,[role="button"]')) {
      if (yes.test((b.textContent || '').trim())) { b.click(); return true; }
    }
  }
  return false;
})()`;

function fail(job: Job, e: unknown): void {
  job.status = job.cancelled ? 'cancelled' : 'error';
  job.error = job.cancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e);
}

async function captureOne(job: Job, browser: Browser, width: number, mobile: boolean, label: string, slot: number, slots: number): Promise<string> {
  const { req } = job;
  const page = await browser.newPage();
  job.pages.push(page);
  let lastBeat = Date.now(); // any progress counts as a sign of life for the stall watchdog
  const set = (stage: string, pct: number) => {
    lastBeat = Date.now();
    job.stage = slots > 1 ? `${label}: ${stage}` : stage;
    job.pct = (slot + pct) / slots;
  };
  let blockedReason = '';
  try {
    await page.setViewport({ width, height: req.height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    if (mobile) await page.setUserAgent(MOBILE_UA);

    if (PUBLIC) {
      // Every request the page makes (including redirects and sub-resources) must stay on the public internet.
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        const u = r.url();
        if (!/^https?:/i.test(u)) return void r.continue().catch(() => undefined);
        assertPublicUrl(u).then(
          () => r.continue().catch(() => undefined),
          (e) => {
            if (r.isNavigationRequest() && r.frame() === page.mainFrame()) blockedReason = e instanceof Error ? e.message : String(e);
            r.abort('blockedbyclient').catch(() => undefined);
          },
        );
      });
      page.on('response', (res) => {
        const ip = res.remoteAddress().ip;
        if (ip && isPrivateAddress(ip.replace(/^\[|\]$/g, '')) && !/^https?:\/\/(localhost|127\.)/.test(req.url)) blockedReason = 'The page tried to reach a private network address.';
      });
    }

    await page.exposeFunction('__w2fProgress', (stage: string, pct: number) => set(String(stage), Number(pct) || 0));
    await page.exposeFunction('__w2fFetch', async (url: string) => {
      try {
        const res = await safeFetch(url, { referer: req.url, 'user-agent': mobile ? MOBILE_UA : 'Mozilla/5.0 Chrome/124 Safari/537.36' });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 12 * 1024 * 1024) return { ok: false, error: 'image too large' };
        return { ok: true, b64: buf.toString('base64'), type: res.headers.get('content-type') ?? '' };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
    await page.exposeFunction('__w2fShot', async (r: { x: number; y: number; w: number; h: number }) => {
      try {
        const b64 = (await page.screenshot({ type: 'png', encoding: 'base64', clip: { x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h) } })) as string;
        return { ok: true, b64 };
      } catch {
        return { ok: false };
      }
    });

    set('Opening the page', 0.02);

    // Some sites reload or redirect themselves a few seconds after "load". Wait until the page has stopped navigating.
    let lastNav = Date.now();
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) lastNav = Date.now();
    });
    const settleNavigation = async () => {
      const t = Date.now();
      while (Date.now() - lastNav < 3500 && Date.now() - t < 30_000) await sleep(250);
      await page.waitForNetworkIdle({ idleTime: 900, timeout: 15_000 }).catch(() => undefined);
      await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => undefined);
    };

    try {
      await page.goto(req.url, { waitUntil: 'load', timeout: 60_000 });
    } catch (e) {
      if (blockedReason) throw new Error(blockedReason);
      throw e;
    }
    if (blockedReason) throw new Error(blockedReason);
    await settleNavigation();
    await sleep(req.waitMs);

    const attempt = async (): Promise<string> => {
      if (req.dismissBanners) {
        const clicked = await page.evaluate(BANNER_SCRIPT).catch(() => false);
        if (clicked) await sleep(900);
      }
      if (job.cancelled) throw new Error('Cancelled');
      if (blockedReason) throw new Error(blockedReason);
      const thumb = (await page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' })) as string;
      await page.evaluate(INJECT);
      set('Reading the page', 0.1);
      return await page.evaluate(
        (args) => (window as unknown as { __w2fRun(a: unknown): Promise<string> }).__w2fRun(args),
        { options: { lazy: req.lazy, speed: req.speed, images: req.images, responsive: false }, thumbnail: `data:image/jpeg;base64,${thumb}` },
      );
    };

    // A stalled page (nothing reported for 3 minutes) or a capture over the time cap is abandoned with a clear message.
    let timer: ReturnType<typeof setInterval> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (Date.now() - lastBeat > 180_000) reject(new Error('The page stopped responding. It may be too heavy, or it blocks automated browsers. Try the Chrome extension for this one.'));
        else if (PUBLIC && Date.now() - job.startedAt > LIMITS.jobMs) reject(new Error('This page took too long to capture on the free server. Try "Balanced" speed, or use the Chrome extension.'));
        else if (blockedReason) reject(new Error(blockedReason));
      }, 5_000);
    });
    try {
      let result: string;
      try {
        result = await Promise.race([attempt(), watchdog]);
      } catch (e) {
        // a late redirect destroys the page context mid-run: wait for it to settle and run once more
        if (!/context was destroyed|navigat|detached|Target closed/i.test(String(e)) || job.cancelled || blockedReason) throw e;
        set('The page reloaded, trying again', 0.05);
        await settleNavigation();
        result = await Promise.race([attempt(), watchdog]);
      }
      return result;
    } finally {
      clearInterval(timer);
    }
  } finally {
    await page.close().catch(() => undefined);
    job.pages = job.pages.filter((p) => p !== page);
  }
}

async function run(job: Job): Promise<void> {
  job.status = 'running';
  job.startedAt = Date.now();
  try {
    job.stage = chromeState === 'downloading' ? 'Starting the server (first use takes about a minute)' : 'Starting Chrome';
    const browser = await getBrowser();
    const sizes = job.req.responsive
      ? [
          { label: 'Desktop', width: job.req.width, mobile: false },
          { label: 'Tablet', width: 768, mobile: false },
          { label: 'Mobile', width: 390, mobile: true },
        ]
      : [{ label: job.req.width <= 480 ? 'Mobile' : job.req.width <= 1000 ? 'Tablet' : 'Desktop', width: job.req.width, mobile: job.req.width <= 480 }];
    const files: Record<string, unknown>[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      try {
        files.push(JSON.parse(await captureOne(job, browser, s.width, s.mobile, s.label, i, sizes.length)));
      } catch (e) {
        if (job.cancelled || i === 0) throw e;
        (files[0].warnings as string[]).push(`${s.label} layout skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const base = files[0] as { label?: string; breakpoints?: unknown[]; source: { viewport: { w: number } } };
    if (files.length > 1) {
      const name = (w: number) => (w >= 1000 ? 'Desktop' : w >= 600 ? 'Tablet' : 'Mobile');
      base.label = `${name(sizes[0].width)} · ${sizes[0].width}`;
      base.breakpoints = files.slice(1).map((f, i) => {
        const w = sizes[i + 1].width;
        delete (f as { thumbnail?: string }).thumbnail;
        return { label: `${name(w)} · ${w}`, width: w, file: f };
      });
    }
    const json = JSON.stringify(base);
    if (json.length > LIMITS.resultBytes) throw new Error('This page is too large for the free server. Try the Chrome extension, or turn images off.');
    job.result = json;
    job.status = 'done';
    job.stage = 'Done';
    job.pct = 1;
  } catch (e) {
    fail(job, e);
  } finally {
    for (const p of job.pages) await p.close().catch(() => undefined);
    job.pages = [];
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function readBody(r: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    r.on('data', (c) => {
      s += c;
      if (s.length > 100_000) reject(new Error('body too large'));
    });
    r.on('end', () => resolve(s));
    r.on('error', reject);
  });
}

function normalizeUrl(raw: string): string {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const u = new URL(hasScheme ? raw : `https://${raw}`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https links can be captured.');
  // a bare "localhost:3000/page" has no scheme: assume http for local development servers
  if (!PUBLIC && !hasScheme && /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(raw)) u.protocol = 'http:';
  return u.toString();
}

/** The visitor behind this request (the host's proxy puts the real address in x-forwarded-for). */
function clientOf(rq: http.IncomingMessage): string {
  const xff = String(rq.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return xff || rq.socket.remoteAddress || 'unknown';
}

/** Returns minutes to wait when this visitor is over the hourly allowance, or 0. */
function rateLimited(client: string, cost: number): number {
  const now = Date.now();
  const list = (history.get(client) ?? []).filter((t) => now - t < 3_600_000);
  history.set(client, list);
  if (list.length + cost > LIMITS.perHour) return Math.max(1, Math.ceil((3_600_000 - (now - list[0])) / 60_000));
  for (let i = 0; i < cost; i++) list.push(now);
  if (history.size > 5000) history.clear();
  return 0;
}

const statusPage = () =>
  `<!doctype html><meta charset="utf-8"><title>Web2Fig helper</title><body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 20px"><h1 style="color:#15803d">✓ Web2Fig helper is running</h1><p>Browser: <b>${chromeState === 'ready' ? 'ready' : chromeState === 'downloading' ? 'downloading (first start)…' : chromeState === 'failed' ? 'failed: ' + chromeError : 'starting…'}</b></p><p>${PUBLIC ? 'This server is used by the <b>Web2Fig</b> Figma plugin: paste a website link in the plugin and click <b>Fetch design</b>.' : 'Now go back to Figma: <b>Plugins → Development → Web2Fig → From a link</b>. Keep the helper window open.'}</p></body>`;

const server = http.createServer(async (rq, rs) => {
  const origin = rq.headers.origin;
  // Figma's plugin window reports its origin as "null". Real web pages send their own origin: those are refused,
  // so a website you visit cannot drive this helper.
  if (origin && origin !== 'null' && origin !== process.env.WEB2FIG_ALLOW_ORIGIN) {
    rs.writeHead(403).end('forbidden');
    return;
  }
  rs.setHeader('Access-Control-Allow-Origin', '*');
  rs.setHeader('Access-Control-Allow-Headers', 'content-type, x-web2fig');
  rs.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  rs.setHeader('Access-Control-Allow-Private-Network', 'true');
  rs.setHeader('Cache-Control', 'no-store');
  if (rq.method === 'OPTIONS') {
    rs.writeHead(204).end();
    return;
  }
  const send = (code: number, body: unknown, gzip = false) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (gzip && String(rq.headers['accept-encoding'] ?? '').includes('gzip')) {
      const z = zlib.gzipSync(text, { level: 6 });
      rs.writeHead(code, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': z.length }).end(z);
    } else rs.writeHead(code, { 'content-type': 'application/json' }).end(text);
  };
  try {
    const url = new URL(rq.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // opening the address in a browser shows a friendly status page
    if (rq.method === 'GET' && parts.length === 0) {
      rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(statusPage());
      return;
    }

    if (rq.method === 'GET' && parts[0] === 'health') {
      const chrome = chromeState === 'ready' ? 'found' : chromeState === 'failed' ? 'missing' : 'downloading';
      return send(200, { ok: true, name: 'web2fig-helper', version: VERSION, chrome, hosted: PUBLIC, queue: waiting });
    }

    if (rq.method === 'POST' && parts[0] === 'capture') {
      if (rq.headers['x-web2fig'] !== '1') return send(400, { error: 'missing header' });
      const b = JSON.parse((await readBody(rq)) || '{}') as Partial<JobRequest> & { url?: string };
      if (chromeState === 'failed') void ensureChrome().catch(() => undefined); // retry the download
      let target: string;
      try {
        target = normalizeUrl(String(b.url ?? '').trim());
        if (PUBLIC) await assertPublicUrl(target);
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : 'Invalid link' });
      }
      const jr: JobRequest = {
        url: target,
        width: Math.min(3840, Math.max(320, Math.round(b.width ?? 1440))),
        height: Math.min(2400, Math.max(500, Math.round(b.height ?? 900))),
        lazy: b.lazy !== false,
        speed: b.speed === 'thorough' ? 'thorough' : 'balanced',
        images: b.images !== false,
        responsive: !!b.responsive,
        waitMs: Math.min(PUBLIC ? 5_000 : 30_000, Math.max(0, Math.round(b.waitMs ?? 1500))),
        dismissBanners: b.dismissBanners !== false,
      };
      const client = clientOf(rq);
      if (PUBLIC) {
        if (waiting >= LIMITS.queue) return send(503, { error: 'The server is busy right now. Please try again in a minute.' });
        const mins = rateLimited(client, jr.responsive ? 3 : 1);
        if (mins) return send(429, { error: `You have used the free allowance for now. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.` });
      }
      const job: Job = { id: randomUUID(), client, req: jr, status: 'queued', stage: 'Waiting in line', pct: 0, pages: [], cancelled: false, startedAt: Date.now() };
      jobs.set(job.id, job);
      waiting++;
      chain = chain.then(async () => {
        waiting--;
        if (!job.cancelled) await run(job);
      });
      // forget finished jobs after a while
      setTimeout(() => jobs.delete(job.id), 30 * 60_000).unref();
      return send(200, { id: job.id });
    }

    if (parts[0] === 'jobs' && parts[1]) {
      const job = jobs.get(parts[1]);
      if (!job) return send(404, { error: 'unknown job' });
      if (rq.method === 'DELETE') {
        job.cancelled = true;
        if (job.status === 'queued') job.status = 'cancelled';
        for (const p of job.pages) await p.close().catch(() => undefined);
        return send(200, { ok: true });
      }
      if (rq.method === 'GET' && parts[2] === 'result') {
        if (job.status !== 'done' || !job.result) return send(409, { error: 'not ready' });
        return send(200, job.result, true);
      }
      if (rq.method === 'GET') return send(200, { status: job.status, stage: job.stage, pct: job.pct, error: job.error });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Is the Web2Fig helper already running in another window?`);
  else console.error(e);
  process.exit(1);
});

if (PUBLIC) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Web2Fig helper ${VERSION} (hosted) listening on port ${PORT}`);
    void ensureChrome().catch((e) => console.error(String(e)));
  });
} else {
  // Listen on both loopback addresses (IPv4 and IPv6) so "localhost" works either way. Never on the network.
  const server6 = http.createServer(server.listeners('request')[0] as http.RequestListener);
  server6.on('error', () => undefined); // no IPv6 loopback on this machine: fine
  server6.listen(PORT, '::1');
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Web2Fig helper ${VERSION} is running on http://localhost:${PORT}`);
    console.log('  (open that address in Chrome to see a green check)');
    void ensureChrome().then((p) => console.log(`  Using Chrome: ${p}`), (e) => console.log(`  ! ${String(e)}`));
    console.log('\n  Leave this window open, then use the Web2Fig plugin in Figma: paste a link and click "Fetch design".');
    console.log('  Press Ctrl+C to stop.\n');
  });
}

const shutdown = async () => {
  try {
    if (browserPromise) await (await browserPromise).close();
  } catch {
    /* already closed */
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
