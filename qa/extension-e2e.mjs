// End-to-end test of the real, built extension (dist/extension) in a real browser.
//   npm run build && node qa/extension-e2e.mjs
// It serves a small page whose images live on a second origin that refuses hotlinking (403 unless the Referer is the page),
// the same protection many real sites use, then runs Full page, Visible area, Pick element and a sized capture.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { png } from '../scripts/icons.mjs';

const root = path.resolve(import.meta.dirname, '..');
const ext = path.join(root, 'dist', 'extension');
const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
if (!chromePath) throw new Error('Chrome or Edge not found (set CHROME_PATH).');

const PAGE = 'http://localhost:5901';
const IMG = 'http://127.0.0.1:5902';
const log = { imageHits: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

/* image server: 403 without the right Referer */
http
  .createServer((q, r) => {
    const ok = (q.headers.referer ?? '').startsWith(PAGE);
    log.imageHits.push(ok ? 200 : 403);
    if (!ok) return r.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked');
    r.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(png(96));
  })
  .listen(5902);

/* page server */
const html = `<!doctype html><meta charset="utf-8"><title>E2E page</title>
<style>body{margin:0;font:16px system-ui;background:#f5f1ea} header{padding:24px 40px;background:#2a1113;color:#fff}
.card{display:inline-block;margin:24px 40px;padding:20px;width:260px;background:#fff;border-radius:14px;box-shadow:0 4px 14px #0002}
.card img{width:220px;height:140px;object-fit:cover;border-radius:10px;display:block;margin-bottom:12px}
.tall{height:1400px;padding:40px}</style>
<header><h1>Hotlink test</h1></header>
<div id="cards"><div class="card" id="card1"><img src="${IMG}/a.png?1" alt=""><b>First card</b></div><div class="card" id="card2"><img src="${IMG}/b.png?2" alt=""><b>Second card</b></div><div class="card" id="card3"><img src="${IMG}/c.png?3" alt=""><b>Third card</b></div></div>
<div class="tall"><p>Below the fold.</p></div>`;
http.createServer((q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(html)).listen(5901);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  pipe: true,
  enableExtensions: [ext], // recent Chrome no longer honours --load-extension, so use Puppeteer's own loader
  args: ['--no-first-run', '--window-size=1280,900'],
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extension loaded, id', extId, '\n');

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(PAGE, { waitUntil: 'load' });
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  const send = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  async function runCapture(mode, options, interact) {
    await page.bringToFront();
    await sleep(300);
    const before = (await send({ type: 'webframe:getLast' }))?.summary?.at ?? 0;
    const started = await send({ type: 'webframe:start', mode, options: { lazy: false, speed: 'balanced', images: true, responsive: false, width: null, ...options } });
    if (!started?.ok) throw new Error('could not start: ' + JSON.stringify(started));
    if (interact) await interact();
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const last = await send({ type: 'webframe:getLast' });
      if (last?.summary && last.summary.at > before) {
        const got = await send({ type: 'webframe:downloadLast' });
        return { summary: got.summary, file: JSON.parse(got.json) };
      }
    }
    throw new Error('capture did not finish');
  }

  /* 1. Full page: images from the hotlink-protected server must arrive */
  log.imageHits.length = 0;
  let r = await runCapture('full', {});
  const assets = Object.keys(r.file.assets ?? {}).length;
  check('Full page: captured', r.file.stats.layers > 5, `layers=${r.file.stats.layers}`);
  check('Full page: hotlink-protected images included', r.file.stats.images >= 3 && assets >= 1, `images=${r.file.stats.images}, assets=${assets}`);
  check('Full page: server refused once, then accepted with the page Referer', log.imageHits.includes(403) && log.imageHits.includes(200), `hits=${[...new Set(log.imageHits)].join('/')}`);

  /* 2. Visible area */
  r = await runCapture('visible', {});
  check('Visible area: captured only the screen', r.file.source.mode === 'visible' && r.file.root.h <= 900, `mode=${r.file.source.mode}, h=${Math.round(r.file.root.h)}`);
  check('Visible area: images included', r.file.stats.images >= 3, `images=${r.file.stats.images}`);

  /* 3. Pick element: hover + click the second card */
  const box = await (await page.$('#card2')).boundingBox();
  r = await runCapture('element', {}, async () => {
    await sleep(1200);
    await page.mouse.move(box.x + 8, box.y + 8); // the card padding, not the image inside it
    await sleep(500);
    await page.mouse.click(box.x + 8, box.y + 8);
  });
  const rw = Math.round(r.file.root.w);
  check('Pick element: only the chosen card captured', r.file.source.mode === 'element' && Math.abs(rw - Math.round(box.width)) <= 2 && r.file.root.h < 400, `mode=${r.file.source.mode}, ${rw}x${Math.round(r.file.root.h)} (card ${Math.round(box.width)}x${Math.round(box.height)})`);
  check('Pick element: its image included', r.file.stats.images >= 1, `images=${r.file.stats.images}`);

  /* 4. Sized capture: opens a temporary window of the chosen width */
  r = await runCapture('full', { width: 412 });
  const vw = Math.round(r.file.source?.viewport?.w ?? 0);
  check('Screen size 412: captured at that width', Math.abs(vw - 412) <= 2, `viewport=${vw}, label=${r.file.label ?? '-'}`);
  check('Screen size 412: images included', r.file.stats.images >= 3, `images=${r.file.stats.images}`);
} catch (e) {
  console.log('ERROR', e instanceof Error ? e.message : e);
  failures++;
} finally {
  await browser.close();
  process.exit(failures ? 1 : 0);
}
