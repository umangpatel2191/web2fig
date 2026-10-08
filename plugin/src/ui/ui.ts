import { DEFAULT_IMPORT_OPTIONS, type ImportOptions, type ImportResult, type MainToUi, type UiToMain } from '../../../shared/messages';
import { BRAND, logoSvg } from '../../../shared/brand';
/**
 * Build-time switch for the "From a link" tab + local helper (see scripts/build.mjs, WEB2FIG_LINK).
 * esbuild replaces it with a literal, so the store build contains none of the link-mode code.
 */
declare const __LINK_MODE__: boolean;
/** Address of the Web2Fig server (the hosted one, or http://localhost:5810 for a local helper) and whether it is hosted. */
declare const __HELPER_URL__: string;
declare const __CLOUD__: boolean;
import { MAGIC, SCHEMA_VERSION, type CaptureFile } from '../../../shared/schema';

type Screen = 'empty' | 'fetching' | 'ready' | 'importing' | 'done' | 'error';
type Tab = 'link' | 'paste';
type SizeChoice = 'desktop' | 'tablet' | 'mobile' | 'all';
type HelperState = 'checking' | 'starting' | 'up' | 'down' | 'nochrome';
let helperError = '';

interface State {
  screen: Screen;
  capture: CaptureFile | null;
  options: ImportOptions;
  result: ImportResult | null;
  error: string;
  /** Message shown on the empty screen when a paste/drop/fetch was rejected. */
  notice: string;
  tab: Tab;
  url: string;
  size: SizeChoice;
  scroll: boolean;
  helper: HelperState;
}

const state: State = { screen: 'empty', capture: null, options: { ...DEFAULT_IMPORT_OPTIONS }, result: null, error: '', notice: '', tab: __LINK_MODE__ ? 'link' : 'paste', url: '', size: 'desktop', scroll: true, helper: 'checking' };

const HELPER = __HELPER_URL__;
const SIZE_PX: Record<Exclude<SizeChoice, 'all'>, number> = { desktop: 1440, tablet: 768, mobile: 390 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const app = document.getElementById('app') as HTMLElement;
const isMac = /mac|iphone|ipad/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const send = (msg: UiToMain) => parent.postMessage({ pluginMessage: msg }, '*');

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const n = (v: number) => v.toLocaleString();

function host(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url;
}

function validate(text: string): CaptureFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That isn’t a Web2Fig capture. Use the Web2Fig Edge extension to capture a page first.');
  }
  const f = data as Partial<CaptureFile>;
  if (!f || f.magic !== MAGIC || !f.root) throw new Error('That isn’t a Web2Fig capture. Use the Web2Fig Edge extension to capture a page first.');
  if ((f.version ?? 0) > SCHEMA_VERSION) throw new Error('This capture was made by a newer version of Web2Fig. Update the plugin and try again.');
  f.assets ||= {};
  f.fonts ||= [];
  f.warnings ||= [];
  f.stats ||= { layers: 0, texts: 0, images: 0, svgs: 0 };
  return f as CaptureFile;
}

function load(text: string): void {
  try {
    state.capture = validate(text);
    state.notice = '';
    go('ready');
  } catch (e) {
    state.notice = e instanceof Error ? e.message : String(e);
    go('empty');
  }
}

/* ------------------------------------------------------------------ */
/* Helper (local server that opens the link in Chrome)                 */
/* ------------------------------------------------------------------ */

async function hf(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(HELPER + path, { ...init, signal: ctl.signal, headers: { 'x-web2fig': '1', ...(init.headers as Record<string, string> | undefined) } });
  } finally {
    clearTimeout(timer);
  }
}

function paintHelper(): void {
  const el = document.getElementById('helper');
  if (!el) return;
  el.dataset.state = state.helper;
  const text = __CLOUD__
    ? { checking: 'Connecting to the Web2Fig server…', starting: 'Server is starting up (the first request can take a minute)…', up: 'Connected to the Web2Fig server', down: 'Server is waking up or unreachable. Retrying…', nochrome: 'Server is starting up…' }[state.helper]
    : { checking: 'Looking for the helper…', starting: 'Helper is getting Chrome ready (first start only)…', up: 'Helper connected', down: 'Helper not running', nochrome: 'Helper is running, but Chrome was not found' }[state.helper];
  const t = document.getElementById('helperText');
  if (t) t.textContent = text;
  const d = document.getElementById('helperErr');
  if (d) d.textContent = state.helper === 'down' && helperError ? `Details: ${helperError}` : '';
  const setup = document.getElementById('setup') as HTMLDetailsElement | null;
  if (setup && state.helper === 'down' && !setup.dataset.touched) setup.open = true;
  if (setup && state.helper === 'up') setup.open = false;
}

async function checkHelper(): Promise<void> {
  try {
    const r = await hf('/health', {}, __CLOUD__ ? 15_000 : 2500); // a sleeping hosted server needs a moment to wake
    const j = (await r.json()) as { ok?: boolean; chrome?: string };
    state.helper = j.ok ? (j.chrome === 'missing' ? 'nochrome' : j.chrome === 'downloading' ? 'starting' : 'up') : 'down';
    helperError = '';
  } catch (e) {
    state.helper = 'down';
    helperError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  paintHelper();
}

if (__LINK_MODE__) {
  setInterval(() => {
    if (state.screen === 'empty' && state.tab === 'link') void checkHelper();
  }, 3000);
}

let fetchToken = 0;
let fetchJobId: string | null = null;

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|aborted|load failed/i.test(m))
    return __CLOUD__
      ? 'Could not reach the Web2Fig server. It may be waking up: wait a few seconds and try again.'
      : 'Could not reach the Web2Fig helper. Start “Start Web2Fig Helper” on this computer (keep its window open), then try again.';
  return m;
}

async function startFetch(): Promise<void> {
  const input = document.getElementById('url') as HTMLInputElement | null;
  const raw = (input?.value ?? state.url).trim();
  state.url = raw;
  if (!raw) {
    state.notice = 'Paste a website address first.';
    return go('empty');
  }
  const token = ++fetchToken;
  fetchJobId = null;
  state.notice = '';
  go('fetching');
  try {
    const responsive = state.size === 'all';
    const body = {
      url: raw,
      width: state.size === 'all' ? SIZE_PX.desktop : SIZE_PX[state.size],
      responsive,
      lazy: state.scroll,
      speed: 'balanced',
      images: true,
    };
    const r = await hf('/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json()) as { id?: string; error?: string };
    if (!r.ok || !j.id) throw new Error(j.error ?? 'The helper could not start the capture.');
    fetchJobId = j.id;
    for (;;) {
      await sleep(600);
      if (token !== fetchToken) return;
      const st = (await (await hf('/jobs/' + j.id)).json()) as { status: string; stage: string; pct: number; error?: string };
      if (token !== fetchToken) return;
      paintFetch(st.stage, st.pct);
      if (st.status === 'done') break;
      if (st.status === 'error' || st.status === 'cancelled') throw new Error(st.error ?? 'The capture failed.');
    }
    const res = await hf('/jobs/' + j.id + '/result', {}, 180_000);
    if (token !== fetchToken) return;
    load(await res.text());
  } catch (e) {
    if (token !== fetchToken) return;
    state.notice = friendly(e);
    go('empty');
  }
}

function paintFetch(stage: string, pct: number): void {
  const fg = document.getElementById('fRingFg');
  if (!fg) return;
  const shown = Math.max(2, Math.min(100, Math.round(pct * 100)));
  fg.style.strokeDashoffset = String(100 - shown);
  document.getElementById('fPct')!.textContent = `${shown}%`;
  document.getElementById('fStage')!.textContent = stage.replace(/…$/, '') + '…';
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

const ICON_PASTE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="5" width="12" height="16" rx="2.5"/><path d="M9.5 5V4a1 1 0 011-1h3a1 1 0 011 1v1M9 12h6M9 16h4"/></svg>';
const ICON_IMAGE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>';
const ICON_SHIELD = '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';

const header = () =>
  `<header class="top"><span class="mark">${logoSvg(32)}</span><div class="id"><b>${BRAND.name}</b><span class="t">${BRAND.tagline}</span></div><span class="pill">Plugin</span></header>`;

/** A screen = header + scrollable body + (optional) pinned action bar. */
const screen = (body: string, actions = '', bodyClass = ''): string =>
  `<div class="screen">${header()}<div class="body ${bodyClass}">${body}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

const ICON_LINK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/></svg>';

function pastePanel(): string {
  return `
    <div class="drop" id="drop" tabindex="0" role="group" aria-label="Paste your capture here">
      <div class="ico">${ICON_PASTE}</div>
      <b id="dropTitle">Paste your capture</b>
      <div class="keys"><kbd>${MOD}</kbd><span>+</span><kbd>V</kbd></div>
      <div class="ready" id="ready"><i></i>Ready. Press <b>${MOD}+V</b> now</div>
      <button class="pastebtn" id="pasteBtn" type="button">Paste from clipboard</button>
      <div class="or">or drop a .json file here · <button class="link" id="choose" type="button">choose file</button></div>
      ${state.notice ? `<div class="or bad" role="alert">${esc(state.notice)}</div>` : ''}
      <input type="file" id="file" accept=".json,application/json" hidden />
      <textarea id="sink" aria-label="Paste target" tabindex="-1" spellcheck="false"></textarea>
    </div>
    <ol class="steps">
      <li><span class="n">1</span><div><b>Capture a page</b><span>Click the ${BRAND.name} icon in Edge.</span></div></li>
      <li><span class="n">2</span><div><b>It copies itself</b><span>Nothing to download. It is on your clipboard.</span></div></li>
      <li><span class="n">3</span><div><b>Paste here</b><span>Review, then import into your file.</span></div></li>
    </ol>`;
}

function linkPanel(): string {
  const sizes: [SizeChoice, string][] = [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Mobile'], ['all', 'All 3 sizes']];
  const idx = sizes.findIndex(([k]) => k === state.size);
  return `
    <div class="linkbox">
      <label class="lbl" for="url">Website address</label>
      <input id="url" type="text" inputmode="url" placeholder="https://example.com" value="${esc(state.url)}" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <div class="lbl" style="margin-top:12px">Size</div>
      <div class="seg4" id="sizeSeg" role="radiogroup" aria-label="Page size" data-i="${idx}">
        <span class="knob" aria-hidden="true"></span>
        ${sizes.map(([k, label]) => `<button type="button" role="radio" data-size="${k}" aria-checked="${k === state.size}">${label}</button>`).join('')}
      </div>
      <p class="hint">${state.size === 'all' ? `Desktop 1440 + tablet 768 + mobile 390, side by side.${__CLOUD__ ? ' Counts as 3 captures.' : ''}` : `Viewport width ${SIZE_PX[state.size as Exclude<SizeChoice, 'all'>]}px.`}</p>
      <label class="opt flat"><span><b>Scroll the page first</b><i>Plays reveal animations, loads lazy images</i></span><input type="checkbox" id="optScroll" ${state.scroll ? 'checked' : ''} /><span class="switch"></span></label>
      ${state.notice ? `<div class="or bad" role="alert" style="margin:10px 0 0">${esc(state.notice)}</div>` : ''}
      <button class="primary" id="fetchBtn" type="button" style="margin-top:12px">Fetch design</button>
      <div class="helper" id="helper" data-state="${state.helper}"><i></i><span id="helperText"></span><button class="link" id="recheck" type="button">Check again</button></div>
      <div class="hint" id="helperErr" style="word-break:break-word"></div>
      ${__CLOUD__ ? `<details class="setup" id="setup"><summary>How link mode works</summary><p>Your link is opened by the Web2Fig server in a private browser. The page is turned into layers, sent back to this plugin and then discarded: nothing is stored. Pages that need a login, and sites that block servers, can't be captured this way: use the Web2Fig browser extension for those. To keep the free server fast, each visitor gets a limited number of captures per hour.</p></details>` : `<details class="setup" id="setup">
        <summary>How to start the helper</summary>
        <ol>
          <li>Open the <b>helper</b> folder that came with the plugin.</li>
          <li>Double-click <b>Start Web2Fig Helper.bat</b> (Mac: <b>start-web2fig-helper.command</b>). The first run installs one small piece.</li>
          <li>Leave its window open. This plugin finds it by itself.</li>
          <li>To test it, open <b>http://localhost:5810</b> in Chrome. You should see a green check.</li>
        </ol>
        <p>It runs on your computer and uses your own Chrome. Nothing is uploaded.</p>
      </details>`}
    </div>`;
}

function tabsMarkup(link: boolean): string {
  return `<div class="tabs" id="tabs" role="tablist" data-i="${link ? 0 : 1}">
      <span class="knob" aria-hidden="true"></span>
      <button type="button" role="tab" data-tab="link" aria-selected="${link}">${ICON_LINK}<span>From a link</span></button>
      <button type="button" role="tab" data-tab="paste" aria-selected="${!link}">${ICON_PASTE.replace(/width="22" height="22"/, 'width="16" height="16"')}<span>Paste capture</span></button>
    </div>`;
}

function emptyScreen(): string {
  const link = __LINK_MODE__ && state.tab === 'link';
  return screen(`
    <div class="hero compact">
      <h1>Turn any website into <em>editable Figma layers</em></h1>
    </div>
    ${__LINK_MODE__ ? tabsMarkup(link) : ''}
    ${__LINK_MODE__ && link ? linkPanel() : pastePanel()}
    <div class="privacy">${ICON_SHIELD}<span>${__CLOUD__ && link ? 'Link mode opens the page on the Web2Fig server. Nothing is stored.' : 'Everything runs locally. Nothing leaves your computer.'}</span></div>`);
}

function fetchingScreen(): string {
  return screen(
    `
    <div class="ring">
      <svg viewBox="0 0 44 44"><defs><linearGradient id="g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b5cf6"/><stop offset="1" stop-color="#9b4df0"/></linearGradient></defs>
        <circle class="bg" cx="22" cy="22" r="18" pathLength="100"/><circle class="fg" id="fRingFg" cx="22" cy="22" r="18" pathLength="100" style="stroke:url(#g2);stroke-dashoffset:98"/></svg>
      <div class="pct" id="fPct">2%</div>
    </div>
    <h2 id="fStage">Starting…</h2>
    <p id="fNote">${esc(host(state.url) || state.url)}</p>`,
    `<button class="secondary" id="fCancel">Cancel</button>`,
    'center',
  );
}

function readyScreen(): string {
  const c = state.capture!;
  const o = state.options;
  const thumb = c.thumbnail && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(c.thumbnail) ? c.thumbnail : '';
  const mode = c.source.mode === 'full' ? 'Full page' : c.source.mode === 'visible' ? 'Visible area' : 'Element';
  const opt = (id: keyof ImportOptions, title: string, sub: string) => `
    <label class="opt"><span><b>${title}</b><i>${sub}</i></span><input type="checkbox" data-opt="${id}" ${o[id] ? 'checked' : ''} /><span class="switch"></span></label>`;
  return screen(
    `
    <div class="card">
      <div class="thumb ${thumb ? '' : 'none'}" ${thumb ? `style="background-image:url('${thumb}')"` : ''}>${thumb ? '' : ICON_IMAGE}<span class="badge">${mode}</span></div>
      <div class="meta"><h2>${esc(c.source.title || host(c.source.url))}</h2><p>${esc(host(c.source.url))}</p></div>
      <div class="chips">
        <span class="chip"><b>${n(c.stats.layers)}</b> layers</span>
        <span class="chip"><b>${n(c.stats.texts)}</b> texts</span>
        <span class="chip"><b>${n(c.stats.images)}</b> images</span>
        <span class="chip"><b>${n(c.fonts.length)}</b> fonts</span>
        <span class="chip"><b>${Math.round(c.root.w)}×${Math.round(c.root.h)}</b></span>
        ${c.breakpoints?.length ? `<span class="chip"><b>${1 + c.breakpoints.length}</b> sizes</span>` : ''}
      </div>
    </div>
    <div class="sect">Import options</div>
    <div class="opts">
      ${opt('autoLayout', 'Smart Auto Layout', 'Only where it matches the original exactly')}
      ${opt('images', 'Images', 'Photos, backgrounds and SVG graphics')}
      ${opt('variables', 'Color variables', 'Create variables from the page’s palette')}
      ${opt('textStyles', 'Text styles', 'Reusable styles for typography that repeats')}
      ${opt('newPage', 'Place on a new page', 'Keeps your current page untouched')}
    </div>`,
    `<button class="primary" id="import">Import to Figma</button><button class="secondary" id="discard">Discard</button>`,
  );
}

function importingScreen(): string {
  return screen(
    `
    <div class="ring">
      <svg viewBox="0 0 44 44"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b5cf6"/><stop offset="1" stop-color="#9b4df0"/></linearGradient></defs>
        <circle class="bg" cx="22" cy="22" r="18" pathLength="100"/><circle class="fg" id="ringFg" cx="22" cy="22" r="18" pathLength="100"/></svg>
      <div class="pct" id="pct">0%</div>
    </div>
    <h2 id="stage">Preparing…</h2>
    <p id="count">Loading fonts</p>`,
    `<button class="secondary" id="cancel">Cancel</button>`,
    'center',
  );
}

function doneScreen(): string {
  const r = state.result!;
  const subs = r.substitutions;
  const notes = r.warnings;
  return screen(
    `
    <div class="done-head">
      <div class="badge-ok"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h2>Imported to your canvas</h2>
      <p>Selected and zoomed into view · ${(r.ms / 1000).toFixed(1)}s</p>
    </div>
    <div class="grid">
      <div class="stat"><b>${n(r.layers)}</b><span>layers</span></div>
      <div class="stat"><b>${r.autoLayouts}</b><span>auto layouts</span></div>
      <div class="stat"><b>${r.variables}</b><span>variables</span></div>
    </div>
    ${
      subs.length
        ? `<details class="notice warn" open><summary>${subs.length} font${subs.length > 1 ? 's' : ''} substituted</summary>
            <ul>${subs.map((s) => `<li><b>${esc(s.requested)}</b> → ${esc(s.used)} · ${n(s.count)} text${s.count === 1 ? '' : 's'}</li>`).join('')}</ul>
            <p style="margin-top:8px;color:var(--text-2)">Letter-spacing was adjusted so every line keeps its original width. Install these fonts (or enable them in Figma) and re-import for exact typography.</p></details>`
        : ''
    }
    ${r.imagesFailed ? `<div class="notice warn"><b>${r.imagesFailed}</b> image${r.imagesFailed > 1 ? 's' : ''} could not be placed.</div>` : ''}
    ${
      notes.length
        ? `<details class="notice"><summary>${notes.length} note${notes.length > 1 ? 's' : ''} from the capture</summary><ul>${notes.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`
        : ''
    }
    ${
      r.autoLayoutCandidates
        ? `<p class="fine">Auto Layout applied to ${r.autoLayouts} of ${r.autoLayoutCandidates} eligible frames. The rest stay absolute to keep the design pixel-accurate.</p>`
        : ''
    }`,
    `<button class="primary" id="again">Import another page</button>`,
  );
}

function errorScreen(): string {
  return screen(
    `
    <div class="badge-err"><svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg></div>
    <h2>Import failed</h2>
    <p class="err-text">${esc(state.error)}</p>`,
    `<button class="primary" id="back">Back</button>`,
    'center',
  );
}

/* ------------------------------------------------------------------ */
/* Rendering and events                                                */
/* ------------------------------------------------------------------ */

function go(screen: Screen): void {
  state.screen = screen;
  app.innerHTML = { empty: emptyScreen, fetching: __LINK_MODE__ ? fetchingScreen : emptyScreen, ready: readyScreen, importing: importingScreen, done: doneScreen, error: errorScreen }[screen]();
  bind();
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function bind(): void {
  switch (state.screen) {
    case 'empty': {
      document.querySelectorAll<HTMLButtonElement>('#tabs [data-tab]').forEach((b) =>
        b.addEventListener('click', () => {
          state.tab = b.dataset.tab as Tab;
          state.notice = '';
          go('empty');
        }),
      );
      if (!__LINK_MODE__ || state.tab === 'paste') {
        const drop = $('drop')!;
        const file = $<HTMLInputElement>('file')!;
        const sink = $<HTMLTextAreaElement>('sink')!;
        // Clicking the box means "I'm about to paste": focus the paste target (never open a file dialog here).
        const arm = () => {
          sink.focus({ preventScroll: true });
          drop.classList.add('armed');
          drop.classList.remove('pulse');
          void drop.offsetWidth; // restart the pulse animation
          drop.classList.add('pulse');
        };
        sink.addEventListener('blur', () => drop.classList.remove('armed'));
        drop.addEventListener('click', arm);
        drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), arm()));
        $('choose')!.addEventListener('click', (e) => {
          e.stopPropagation();
          file.click();
        });
        $('pasteBtn')!.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const text = await navigator.clipboard.readText();
            if (text) return load(text);
            throw new Error('empty');
          } catch {
            // Figma's plugin frame may block direct clipboard reads. The keyboard shortcut always works.
            state.notice = '';
            arm();
            $('dropTitle')!.textContent = `Press ${MOD}+V to paste`;
          }
        });
        file.addEventListener('change', () => file.files?.[0] && void readFile(file.files[0]));
        queueMicrotask(arm); // ready to paste as soon as the window opens, no click needed
      } else {
        const url = $<HTMLInputElement>('url')!;
        url.addEventListener('input', () => (state.url = url.value));
        url.addEventListener('keydown', (e) => e.key === 'Enter' && void startFetch());
        document.querySelectorAll<HTMLButtonElement>('#sizeSeg [data-size]').forEach((b) =>
          b.addEventListener('click', () => {
            state.size = b.dataset.size as SizeChoice;
            go('empty');
            $('url')?.focus();
          }),
        );
        $<HTMLInputElement>('optScroll')!.addEventListener('change', (e) => (state.scroll = (e.target as HTMLInputElement).checked));
        $('fetchBtn')!.addEventListener('click', () => void startFetch());
        $('recheck')!.addEventListener('click', () => {
          state.helper = 'checking';
          paintHelper();
          void checkHelper();
        });
        $('setup')!.addEventListener('toggle', () => (($('setup') as HTMLElement).dataset.touched = '1'));
        paintHelper();
        void checkHelper();
        if (!state.url) url.focus();
      }
      break;
    }
    case 'fetching':
      if (__LINK_MODE__) {
        $('fCancel')!.addEventListener('click', () => {
          fetchToken++;
          if (fetchJobId) void hf('/jobs/' + fetchJobId, { method: 'DELETE' }).catch(() => undefined);
          go('empty');
        });
      }
      break;
    case 'ready':
      document.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((el) =>
        el.addEventListener('change', () => {
          state.options[el.dataset.opt as keyof ImportOptions] = el.checked;
          send({ type: 'saveSettings', options: state.options });
        }),
      );
      $('import')!.addEventListener('click', startImport);
      $('discard')!.addEventListener('click', () => {
        state.capture = null;
        go('empty');
      });
      break;
    case 'importing':
      $('cancel')!.addEventListener('click', (e) => {
        (e.currentTarget as HTMLButtonElement).disabled = true;
        send({ type: 'cancel' });
      });
      break;
    case 'done':
      $('again')!.addEventListener('click', () => {
        state.capture = null;
        go('empty');
      });
      break;
    case 'error':
      $('back')!.addEventListener('click', () => go(state.capture ? 'ready' : 'empty'));
      break;
  }
}

function startImport(): void {
  if (!state.capture) return;
  go('importing');
  send({ type: 'import', capture: state.capture, options: state.options });
}

async function readFile(file: File): Promise<void> {
  try {
    load(await file.text());
  } catch {
    state.notice = 'Could not read that file.';
    go('empty');
  }
}

function setProgress(done: number, total: number, stage: string): void {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fg = $('ringFg');
  if (!fg) return;
  fg.style.strokeDashoffset = String(100 - pct);
  $('pct')!.textContent = `${pct}%`;
  $('stage')!.textContent = stage;
  $('count')!.textContent = total ? `${n(done)} of ${n(total)} layers` : 'Working…';
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data?.pluginMessage as MainToUi | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'settings':
      state.options = msg.options;
      if (state.screen === 'ready') go('ready');
      break;
    case 'progress':
      setProgress(msg.done, msg.total, msg.stage);
      break;
    case 'done':
      state.result = msg.result;
      go('done');
      break;
    case 'cancelled':
      send({ type: 'notify', text: 'Import cancelled' });
      go('ready');
      break;
    case 'error':
      state.error = msg.message;
      go('error');
      break;
  }
});

// Paste anywhere in the window → load the capture.
window.addEventListener('paste', (e) => {
  if (state.screen !== 'empty' && state.screen !== 'ready') return;
  if ((e.target as HTMLElement | null)?.id === 'url') return; // the address box pastes normally
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  // a plain web address pasted anywhere: switch to link mode and fetch it
  if (__LINK_MODE__ && state.screen === 'empty' && /^\s*(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?\s*$/i.test(text) && !text.trim().startsWith('{')) {
    state.tab = 'link';
    state.url = text.trim();
    go('empty');
    return;
  }
  load(text);
});

// Drag & drop
['dragenter', 'dragover'].forEach((t) =>
  window.addEventListener(t, (e) => {
    e.preventDefault();
    $('drop')?.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((t) => window.addEventListener(t, () => $('drop')?.classList.remove('over')));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && (state.screen === 'empty' || state.screen === 'ready')) void readFile(f);
});

go('empty');
send({ type: 'ready' });
