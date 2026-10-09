// Generates the store artwork (icons, posters, screenshots) from the real, current UI.
//   npm run build && node scripts/store-assets.mjs
// Output: release/1-Edge-Extension/{store-logo-300x300.png,images/*}  and  release/2-Figma-Plugin/store-listing/{icon-128.png,images/*}
// Needs Google Chrome or Edge installed (set CHROME_PATH to override).
import puppeteer from 'puppeteer-core';
import esbuild from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const edgeOut = path.join(root, 'release', '1-Edge-Extension');
const figmaOut = path.join(root, 'release', '2-Figma-Plugin', 'store-listing');
fs.mkdirSync(path.join(edgeOut, 'images'), { recursive: true });
fs.mkdirSync(path.join(figmaOut, 'images'), { recursive: true });

const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
if (!chromePath) throw new Error('Chrome or Edge not found. Set CHROME_PATH.');

/* the brand mark, straight from shared/brand.ts so artwork and product never drift apart */
const brandJs = esbuild.transformSync(fs.readFileSync(path.join(root, 'shared/brand.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code;
const { logoSvg } = await import('data:text/javascript;base64,' + Buffer.from(brandJs).toString('base64'));

/* tiny static server for the built popup (/ext) and plugin (/plug) */
const server = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  let file;
  if (u.pathname.startsWith('/ext/')) file = path.join(dist, 'extension', u.pathname.slice(5));
  else if (u.pathname === '/plug') file = path.join(dist, 'plugin', 'ui.html');
  if (!file || !fs.existsSync(file)) return r.writeHead(404).end();
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] ?? 'application/octet-stream';
  r.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
});
await new Promise((res) => server.listen(5893, res));
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- real UI captures (2× for crisp posters) ---------- */
const SAMPLE = { title: 'Northwind: design & brand studio', url: 'https://northwind.example/', layers: 1284, texts: 312, images: 46, bytes: 742000, at: Date.now() - 90_000, copied: true, warnings: [] };

async function shotPopup(state) {
  const p = await browser.newPage();
  await p.setViewport({ width: 380, height: 700, deviceScaleFactor: 2 });
  await p.evaluateOnNewDocument((last) => {
    window.__ls = [];
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.2.0' }),
        sendMessage: async (m) => (m.type === 'webframe:getLast' ? { summary: last } : { ok: true, json: null }),
        onMessage: { addListener: (f) => window.__ls.push(f) },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  }, state === 'idle' ? null : SAMPLE);
  await p.goto('http://localhost:5893/ext/popup.html', { waitUntil: 'load' });
  await sleep(500);
  if (state === 'busy') await p.evaluate(() => window.__ls.forEach((f) => f({ type: 'webframe:progress', stage: 'Capturing images and backgrounds', pct: 0.62 })));
  if (state === 'done') await p.evaluate((s) => window.__ls.forEach((f) => f({ type: 'webframe:done', summary: s })), SAMPLE);
  await sleep(700);
  const el = await p.$('#app');
  const buf = await el.screenshot({ type: 'png' });
  await p.close();
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function shotPlugin(state) {
  const p = await browser.newPage();
  await p.setViewport({ width: 400, height: 720, deviceScaleFactor: 2 });
  await p.setRequestInterception(true);
  p.on('request', (rq) => {
    if (!rq.url().includes('hf.space')) return rq.continue();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (rq.method() === 'OPTIONS') return rq.respond({ status: 204, headers: cors });
    rq.respond({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, chrome: 'found' }) });
  });
  await p.goto('http://localhost:5893/plug', { waitUntil: 'load' });
  await sleep(1200);
  if (state === 'done')
    await p.evaluate(() => window.postMessage({ pluginMessage: { type: 'done', result: { layers: 1284, autoLayouts: 96, autoLayoutCandidates: 118, variables: 14, ms: 4200, substitutions: [], warnings: [], imagesFailed: 0 } } }, '*'));
  await sleep(900);
  await p.evaluate(() => (document.querySelector('.body').scrollTop = 0));
  const buf = await p.screenshot({ type: 'png' });
  await p.close();
  return 'data:image/png;base64,' + buf.toString('base64');
}

const shots = { popupIdle: await shotPopup('idle'), popupBusy: await shotPopup('busy'), popupDone: await shotPopup('done'), plugin: await shotPlugin('link'), pluginDone: await shotPlugin('done') };

/* ---------- poster pieces ---------- */
const BASE = `*{box-sizing:border-box;margin:0}body{font-family:"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:#fff4e6;overflow:hidden}
.serif{font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif}
.bg{background:radial-gradient(900px 600px at 100% 0%,rgba(216,100,93,.30),transparent 60%),radial-gradient(700px 500px at 0% 100%,rgba(124,43,51,.55),transparent 60%),linear-gradient(135deg,#2a1113,#40181c 55%,#5a1e24)}
.chip{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:999px;background:rgba(255,244,230,.08);border:1px solid rgba(255,244,230,.22);font-weight:600;color:#fff4e6}
.chip::before{content:"";width:9px;height:9px;border-radius:50%;background:#f0877f}
.dev{border-radius:26px;box-shadow:0 40px 90px rgba(10,0,0,.55),0 0 0 1px rgba(255,244,230,.16);display:block}
.card{background:rgba(255,244,230,.07);border:1px solid rgba(255,244,230,.18);border-radius:28px}
.ico{width:64px;height:64px;border-radius:18px;background:rgba(255,244,230,.12);display:grid;place-items:center;color:#f0877f}
.ico svg{width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}`;
const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
const I = {
  text: svg('<path d="M4 7V5h16v2M12 5v14M9 19h6"/>'),
  grid: svg('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>'),
  resp: svg('<rect x="3" y="5" width="13" height="10" rx="2"/><rect x="14" y="9" width="7" height="11" rx="2"/>'),
  mask: svg('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  cam: svg('<rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
};
const card = (i, t, d, h = 300) => `<div class="card" style="padding:34px;min-height:${h}px"><div class="ico">${I[i]}</div><div class="serif" style="font-size:38px;font-weight:700;margin:22px 0 10px">${t}</div><div style="font-size:23px;line-height:1.45;opacity:.9">${d}</div></div>`;
const step = (n, t, d) => `<div class="card" style="flex:1;padding:38px;min-height:430px"><div class="ico" style="font:700 34px 'Palatino Linotype',Georgia,serif;color:#fff4e6">${n}</div><div class="serif" style="font-size:42px;font-weight:700;margin:26px 0 12px">${t}</div><div style="font-size:24px;line-height:1.45;opacity:.9">${d}</div></div>`;
const brandRow = (s, name = 84) => `<div style="display:flex;align-items:center;gap:${Math.round(s / 4)}px"><div style="filter:drop-shadow(0 14px 28px rgba(0,0,0,.45))">${logoSvg(s)}</div><b class="serif" style="font-size:${name}px;letter-spacing:-.02em">Web2Fig</b></div>`;

const FIGMA = {
  'cover-1920x1080': [1920, 1080, `<body class="bg" style="width:1920px;height:1080px;display:flex;align-items:center;gap:90px;padding:0 150px">
    <div style="flex:1">${brandRow(120)}
      <div class="serif" style="font-size:88px;line-height:1.04;font-weight:700;letter-spacing:-.03em;margin-top:44px">Turn any website into editable Figma layers</div>
      <div style="display:flex;gap:16px;margin-top:48px;font-size:23px"><span class="chip">Paste a link</span><span class="chip">Auto Layout</span><span class="chip">Responsive set</span></div></div>
    <img class="dev" src="${shots.plugin}" style="height:880px;margin-right:30px"></body>`],
  'how-it-works-1920x1080': [1920, 1080, `<body class="bg" style="width:1920px;height:1080px;padding:0 120px;display:flex;flex-direction:column;justify-content:center">
    <div class="serif" style="font-size:78px;font-weight:700;letter-spacing:-.03em;margin-bottom:54px">Three steps, no screenshots</div>
    <div style="display:flex;gap:34px">
      ${step('1', 'Paste a link', 'Type a web address in the plugin and pick Desktop, Tablet, Mobile or all three sizes.')}
      ${step('2', 'Review', 'Preview the page, then choose Auto Layout, text styles and colour variables.')}
      ${step('3', 'Import', 'Real frames, text, images and Auto Layout land on your canvas, named and ready to edit.')}
    </div>
    <div style="margin-top:46px;font-size:26px;opacity:.9">No link, or the page needs a login? Capture it with the free Web2Fig Edge extension and paste it here instead.</div></body>`],
  'features-1920x1080': [1920, 1080, `<body class="bg" style="width:1920px;height:1080px;padding:92px 120px">
    <div class="serif" style="font-size:78px;font-weight:700;letter-spacing:-.03em;margin-bottom:46px">Real layers, not a screenshot</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:28px">
      ${card('text', 'Exact text', 'Browser line breaks, fonts and styles arrive as editable text, with clickable links.')}
      ${card('grid', 'Auto Layout', 'Rows, columns and wrapping grids become Auto Layout wherever it matches the page.')}
      ${card('resp', 'Responsive set', 'Desktop, tablet and mobile captured and placed side by side.')}
      ${card('mask', 'Masks &amp; shapes', 'Clip-paths, gradients and masks come across as native Figma masks.')}
      ${card('layers', 'Named layers', 'Header, Section, Button, Image. Text styles and colour variables included.')}
      ${card('link', 'Link or paste', 'Fetch from a link, or paste a capture from the Edge extension. Paste mode stays on your computer.')}
    </div></body>`],
};

const popupCard = (img, h) => `<img class="dev" src="${img}" style="height:${h}px;border-radius:22px">`;
const head = (t, d) => `<div class="serif" style="font-size:66px;line-height:1.05;font-weight:700;letter-spacing:-.03em">${t}</div><div style="font-size:26px;line-height:1.45;opacity:.9;margin-top:22px;max-width:640px">${d}</div>`;
const EDGE = {
  'screenshot-1-capture-1280x800': [1280, 800, `<body class="bg" style="width:1280px;height:800px;display:flex;align-items:center;gap:70px;padding:0 90px"><div style="flex:1">${head('Capture any page in one click', 'Full page, the visible area, or one element. Scrolls the whole page first so animations and lazy images are included.')}</div>${popupCard(shots.popupIdle, 640)}</body>`],
  'screenshot-2-capturing-1280x800': [1280, 800, `<body class="bg" style="width:1280px;height:800px;display:flex;align-items:center;gap:70px;padding:0 90px"><div style="flex:1">${head('Slow, careful, complete', 'Scrolls at a steady pace, loads images and backgrounds, and shows exactly what it is doing.')}</div>${popupCard(shots.popupBusy, 640)}</body>`],
  'screenshot-3-ready-to-paste-1280x800': [1280, 800, `<body class="bg" style="width:1280px;height:800px;display:flex;align-items:center;gap:70px;padding:0 90px"><div style="flex:1">${head('Copied. Now paste into Figma', 'The capture is already on your clipboard. Open the Web2Fig plugin in Figma and press Ctrl+V.')}</div>${popupCard(shots.popupDone, 640)}</body>`],
  'screenshot-4-features-1280x800': [1280, 800, `<body class="bg" style="width:1280px;height:800px;padding:70px 80px"><div class="serif" style="font-size:56px;font-weight:700;letter-spacing:-.03em;margin-bottom:34px">Everything on your computer</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:22px">${[['cam', 'Real layers', 'Text, images, SVG and shapes, not a flat screenshot.'], ['grid', 'Auto Layout ready', 'Structure the plugin turns into Auto Layout.'], ['resp', 'Responsive set', 'Desktop, tablet and mobile in one go.'], ['copy', 'Copy or download', 'Straight to the clipboard, or save a .json.'], ['lock', 'Private', 'No servers, no account, no tracking.'], ['layers', 'Free', 'No limits, no sign-up.']].map(([i, t, d]) => `<div class="card" style="padding:26px;min-height:240px"><div class="ico" style="width:52px;height:52px;border-radius:15px">${I[i]}</div><div class="serif" style="font-size:30px;font-weight:700;margin:16px 0 8px">${t}</div><div style="font-size:19px;line-height:1.4;opacity:.9">${d}</div></div>`).join('')}</div></body>`],
  'small-promo-tile-440x280': [440, 280, `<body class="bg" style="width:440px;height:280px;display:flex;flex-direction:column;justify-content:center;padding:0 34px;gap:14px">${brandRow(64, 44)}<div class="serif" style="font-size:25px;line-height:1.15;font-weight:700">Capture any website as editable Figma layers</div></body>`],
  'large-promo-tile-1400x560': [1400, 560, `<body class="bg" style="width:1400px;height:560px;display:flex;align-items:center;gap:60px;padding:0 90px"><div style="flex:1">${brandRow(84, 62)}<div class="serif" style="font-size:54px;line-height:1.05;font-weight:700;letter-spacing:-.03em;margin-top:26px">Any website to editable Figma layers</div><div style="display:flex;gap:12px;margin-top:28px;font-size:20px"><span class="chip">Free</span><span class="chip">Private</span><span class="chip">Responsive set</span></div></div><img class="dev" src="${shots.popupDone}" style="height:640px;margin-top:130px;border-radius:22px"></body>`],
};

async function render(name, w, h, html, out) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>${BASE}</style>${html}`, { waitUntil: 'load' });
  await sleep(500);
  await p.screenshot({ path: path.join(out, name + '.png'), type: 'png' });
  await p.close();
  console.log('wrote', name);
}
for (const [n, [w, h, html]] of Object.entries(FIGMA)) await render(n, w, h, html, path.join(figmaOut, 'images'));
for (const [n, [w, h, html]] of Object.entries(EDGE)) await render(n, w, h, html, path.join(edgeOut, 'images'));

/* store logo: the mark alone, square, transparent corners */
{
  const p = await browser.newPage();
  await p.setViewport({ width: 300, height: 300 });
  await p.setContent(`<!doctype html><style>body{margin:0;background:transparent}</style>${logoSvg(300)}`);
  await p.screenshot({ path: path.join(edgeOut, 'store-logo-300x300.png'), omitBackground: true });
  await p.close();
  console.log('wrote store-logo-300x300');
}
fs.copyFileSync(path.join(dist, 'plugin', 'icon-128.png'), path.join(figmaOut, 'icon-128.png'));

await browser.close();
server.close();
