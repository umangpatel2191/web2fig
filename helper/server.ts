/**
 * Web2Fig helper: a tiny local server that lets the Figma plugin turn a pasted URL into a capture.
 * It drives your own installed Chrome (hidden), runs the same capture engine as the extension, and returns the result.
 * It listens on 127.0.0.1 only, and refuses requests that come from web pages.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const PORT = Number(process.env.WEB2FIG_PORT) || 5810;
const VERSION = '0.2.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const INJECT = fs.readFileSync(path.join(here, 'inject.js'), 'utf8');

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
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

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (browserPromise) return browserPromise;
  const executablePath = findChrome();
  if (!executablePath) throw new Error('Google Chrome was not found. Install Chrome, or set CHROME_PATH to its location.');
  browserPromise = puppeteer
    .launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-blink-features=AutomationControlled', '--lang=en-US'],
      defaultViewport: null,
    })
    .then((b) => {
      b.on('disconnected', () => (browserPromise = null));
      return b;
    });
  browserPromise.catch(() => (browserPromise = null));
  return browserPromise;
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
  req: JobRequest;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  stage: string;
  pct: number;
  error?: string;
  result?: string;
  pages: Page[];
  cancelled: boolean;
}
const jobs = new Map<string, Job>();
let chain: Promise<unknown> = Promise.resolve(); // one capture at a time

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
  try {
    await page.setViewport({ width, height: req.height, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    if (mobile) await page.setUserAgent(MOBILE_UA);
    await page.exposeFunction('__w2fProgress', (stage: string, pct: number) => set(String(stage), Number(pct) || 0));
    await page.exposeFunction('__w2fFetch', async (url: string) => {
      try {
        const res = await fetch(url, { headers: { referer: req.url, 'user-agent': mobile ? MOBILE_UA : 'Mozilla/5.0 Chrome/124 Safari/537.36' }, signal: AbortSignal.timeout(20_000) });
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

    await page.goto(req.url, { waitUntil: 'load', timeout: 60_000 });
    await settleNavigation();
    await sleep(req.waitMs);

    const attempt = async (): Promise<string> => {
      if (req.dismissBanners) {
        const clicked = await page.evaluate(BANNER_SCRIPT).catch(() => false);
        if (clicked) await sleep(900);
      }
      if (job.cancelled) throw new Error('Cancelled');
      const thumb = (await page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' })) as string;
      await page.evaluate(INJECT);
      set('Reading the page', 0.1);
      return await page.evaluate(
        (args) => (window as unknown as { __w2fRun(a: unknown): Promise<string> }).__w2fRun(args),
        { options: { lazy: req.lazy, speed: req.speed, images: req.images, responsive: false }, thumbnail: `data:image/jpeg;base64,${thumb}` },
      );
    };

    // A stalled page (nothing reported for 3 minutes) is abandoned with a clear message instead of hanging forever.
    let stalled: ReturnType<typeof setInterval> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      stalled = setInterval(() => {
        if (Date.now() - lastBeat > 180_000) reject(new Error('The page stopped responding. It may be too heavy for the helper, or it blocks automated browsers. Try the Chrome extension for this one.'));
      }, 10_000);
    });
    try {
      let result: string;
      try {
        result = await Promise.race([attempt(), watchdog]);
      } catch (e) {
        // a late redirect destroys the page context mid-run: wait for it to settle and run once more
        if (!/context was destroyed|navigat|detached|Target closed/i.test(String(e)) || job.cancelled) throw e;
        set('The page reloaded, trying again', 0.05);
        await settleNavigation();
        result = await Promise.race([attempt(), watchdog]);
      }
      return result;
    } finally {
      clearInterval(stalled);
    }
  } finally {
    await page.close().catch(() => undefined);
    job.pages = job.pages.filter((p) => p !== page);
  }
}

async function run(job: Job): Promise<void> {
  job.status = 'running';
  try {
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
    job.result = JSON.stringify(base);
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
  if (!hasScheme && /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(raw)) u.protocol = 'http:';
  return u.toString();
}

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
  const send = (code: number, body: unknown) => {
    rs.writeHead(code, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    const url = new URL(rq.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // opening http://localhost:5810 in a browser shows a friendly status page
    if (rq.method === 'GET' && parts.length === 0) {
      const chrome = findChrome();
      rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><title>Web2Fig helper</title><body style="font:16px system-ui;max-width:520px;margin:60px auto;padding:0 20px"><h1 style="color:#15803d">✓ Web2Fig helper is running</h1><p>Chrome: <b>${chrome ? 'found' : 'NOT found — install Chrome or set CHROME_PATH'}</b></p><p>Now go back to Figma: <b>Plugins → Development → Web2Fig → From a link</b>. Keep the helper window open.</p></body>`,
      );
      return;
    }

    if (rq.method === 'GET' && parts[0] === 'health') {
      return send(200, { ok: true, name: 'web2fig-helper', version: VERSION, chrome: findChrome() ? 'found' : 'missing' });
    }

    if (rq.method === 'POST' && parts[0] === 'capture') {
      if (rq.headers['x-web2fig'] !== '1') return send(400, { error: 'missing header' });
      const b = JSON.parse((await readBody(rq)) || '{}') as Partial<JobRequest> & { url?: string };
      const chromePath = findChrome();
      if (!chromePath) return send(500, { error: 'Google Chrome was not found. Install Chrome, or set CHROME_PATH to its location.' });
      let target: string;
      try {
        target = normalizeUrl(String(b.url ?? '').trim());
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
        waitMs: Math.min(30_000, Math.max(0, Math.round(b.waitMs ?? 1500))),
        dismissBanners: b.dismissBanners !== false,
      };
      const job: Job = { id: randomUUID(), req: jr, status: 'queued', stage: 'Waiting for Chrome', pct: 0, pages: [], cancelled: false };
      jobs.set(job.id, job);
      chain = chain.then(() => (job.cancelled ? undefined : run(job)));
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
        return send(200, job.result);
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
// Listen on both loopback addresses (IPv4 and IPv6) so "localhost" works either way. Never on the network.
const server6 = http.createServer(server.listeners('request')[0] as http.RequestListener);
server6.on('error', () => undefined); // no IPv6 loopback on this machine: fine
server6.listen(PORT, '::1');
server.listen(PORT, '127.0.0.1', () => {
  const chrome = findChrome();
  console.log(`\n  Web2Fig helper ${VERSION} is running on http://localhost:${PORT}`);
  console.log('  (open that address in Chrome to see a green check)');
  console.log(chrome ? `  Using Chrome: ${chrome}` : '  ! Google Chrome was not found. Install it, or set CHROME_PATH.');
  console.log('\n  Leave this window open, then use the Web2Fig plugin in Figma: paste a link and click "Fetch design".');
  console.log('  Press Ctrl+C to stop.\n');
});

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
