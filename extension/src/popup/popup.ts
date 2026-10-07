import { logoSvg } from '../../../shared/brand';
import { DEFAULT_CAPTURE_OPTIONS, type CaptureMode, type CaptureOptions, type CaptureSummary, type ScrollSpeed } from '../../../shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const isMac = /mac|iphone|ipad/i.test(navigator.platform);

const MODES: CaptureMode[] = ['full', 'visible', 'element'];
const MODE_COPY: Record<CaptureMode, { hint: string; label: string }> = {
  full: { hint: 'The whole scrollable page, top to bottom.', label: 'Capture full page' },
  visible: { hint: 'Only what is on screen right now.', label: 'Capture visible area' },
  element: { hint: 'Hover and click any section, card or component.', label: 'Pick an element' },
};
const SPEED_COPY: Record<ScrollSpeed, string> = {
  balanced: 'Steady. Right for most websites',
  thorough: 'Slower, waits longer. For heavy animations',
};

interface Settings {
  mode: CaptureMode;
  options: CaptureOptions;
}
let settings: Settings = { mode: 'full', options: { ...DEFAULT_CAPTURE_OPTIONS } };

const setState = (s: 'idle' | 'busy' | 'done') => (app.dataset.state = s);

/* ------------------------------------------------------------------ */
/* Idle view                                                           */
/* ------------------------------------------------------------------ */

function renderMode(): void {
  document.querySelectorAll<HTMLButtonElement>('.seg-item').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
  $('modeSeg').dataset.i = String(MODES.indexOf(settings.mode));
  $('modeHint').textContent = MODE_COPY[settings.mode].hint;
  $('captureLabel').textContent = MODE_COPY[settings.mode].label;
  renderScroll();
}

function renderScroll(): void {
  const full = settings.mode === 'full';
  const lazy = settings.options.lazy;
  $('optLazy').closest('.opt')?.classList.toggle('off', !full);
  $('speedRow').classList.toggle('off', !full || !lazy);
  $('respRow').classList.toggle('off', settings.mode === 'element');
  document.querySelectorAll<HTMLButtonElement>('#speedSeg [data-speed]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.speed === settings.options.speed)));
  $('speedSeg').dataset.i = settings.options.speed === 'thorough' ? '1' : '0';
  $('speedNote').textContent = SPEED_COPY[settings.options.speed];
}

const persist = () => chrome.storage.local.set({ settings });

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

function showError(message: string): void {
  const el = $('error');
  el.textContent = message;
  el.hidden = !message;
}

function renderLast(s: CaptureSummary | null): void {
  const el = $('last');
  el.hidden = !s;
  if (!s) return;
  $('lastTitle').textContent = s.title || s.url;
  $('lastMeta').textContent = `${s.layers.toLocaleString()} layers · ${kb(s.bytes)} · ${ago(s.at)}`;
}

/* ------------------------------------------------------------------ */
/* Busy view                                                           */
/* ------------------------------------------------------------------ */

/** Maps the content script's stage names onto the four visible steps. */
function stageIndex(stage: string): number {
  if (/scroll|lazy/i.test(stage)) return 0;
  if (/image|backgrounds/i.test(stage)) return 2;
  if (/packag|clipboard|sending/i.test(stage)) return 3;
  return 1; // reading page, capturing embedded content
}

function setProgress(stage: string, pct: number): void {
  const idx = stageIndex(stage);
  $('busyStage').textContent = `${stage.replace(/…$/, '')}…`;
  const shown = Math.max(2, Math.min(100, Math.round(pct * 100)));
  ($('ringFg') as unknown as SVGCircleElement).style.strokeDashoffset = String(100 - shown);
  $('pct').textContent = `${shown}%`;
  document.querySelectorAll<HTMLLIElement>('#stages li').forEach((li) => {
    const i = Number(li.dataset.stage);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
  $('busyHint').textContent = idx === 0 ? 'Scrolling the whole page so every animation can play. Keep this tab open.' : 'Keep this tab open until it finishes.';
  setState('busy');
}

/* ------------------------------------------------------------------ */
/* Done view                                                           */
/* ------------------------------------------------------------------ */

function renderDone(s: CaptureSummary): void {
  $('doneTitle').textContent = s.copied ? 'Copied to clipboard' : 'Capture ready';
  $('doneSub').textContent = s.copied ? `${s.title || s.url}` : 'The clipboard was blocked. Use “Download .json” and drop the file into the plugin.';
  $('stats').innerHTML = (
    [
      [s.layers.toLocaleString(), 'layers'],
      [s.texts.toLocaleString(), 'texts'],
      [s.images.toLocaleString(), 'images'],
      [kb(s.bytes), 'size'],
    ] as const
  )
    .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`)
    .join('');
  const box = $('warnBox') as HTMLDetailsElement;
  box.hidden = s.warnings.length === 0;
  $('warnSummary').textContent = `${s.warnings.length} note${s.warnings.length === 1 ? '' : 's'} about this capture`;
  $('warnList').replaceChildren(...s.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  setState('done');
}

async function download(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'webframe:downloadLast' })) as { json: string | null; summary: CaptureSummary | null };
  if (!res.json) return;
  let host = 'page';
  try {
    host = new URL(res.summary?.url ?? '').hostname.replace(/^www\./, '') || host;
  } catch {
    /* keep default */
  }
  const url = URL.createObjectURL(new Blob([res.json], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `web2fig-${host}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copy(btn: HTMLButtonElement): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'webframe:copyLast' })) as { ok: boolean };
  const prev = btn.textContent;
  btn.textContent = res.ok ? 'Copied ✓' : 'Blocked';
  setTimeout(() => (btn.textContent = prev), 1400);
}

async function start(): Promise<void> {
  showError('');
  const res = (await chrome.runtime.sendMessage({ type: 'webframe:start', mode: settings.mode, options: settings.options })) as
    | { ok: true }
    | { ok: false; error: string };
  if (!res.ok) return showError(res.error);
  if (settings.mode === 'element') {
    window.close(); // the picker lives on the page
    return;
  }
  setProgress(settings.mode === 'full' && settings.options.lazy ? 'Scrolling through the page' : 'Reading page', 0.02);
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

async function init(): Promise<void> {
  $('mark').innerHTML = logoSvg(36);
  $('ver').textContent = `v${chrome.runtime.getManifest().version}`;
  $('pasteKey').textContent = isMac ? '⌘ V' : 'Ctrl+V';
  $('shortcut').textContent = isMac ? '⌥⇧C' : 'Alt+Shift+C';

  const stored = (await chrome.storage.local.get('settings')).settings as Partial<Settings> | undefined;
  settings = { mode: stored?.mode ?? 'full', options: { ...DEFAULT_CAPTURE_OPTIONS, ...stored?.options } };
  if (settings.options.speed !== 'thorough') settings.options.speed = 'balanced'; // older builds stored `slow: boolean`
  $<HTMLInputElement>('optLazy').checked = settings.options.lazy;
  $<HTMLInputElement>('optImages').checked = settings.options.images;
  $<HTMLInputElement>('optResponsive').checked = settings.options.responsive;
  renderMode();

  document.querySelectorAll<HTMLButtonElement>('.seg-item').forEach((b) =>
    b.addEventListener('click', () => {
      settings.mode = b.dataset.mode as CaptureMode;
      renderMode();
      void persist();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('#speedSeg [data-speed]').forEach((b) =>
    b.addEventListener('click', () => {
      settings.options.speed = b.dataset.speed as ScrollSpeed;
      renderScroll();
      void persist();
    }),
  );
  $<HTMLInputElement>('optLazy').addEventListener('change', (e) => {
    settings.options.lazy = (e.target as HTMLInputElement).checked;
    renderScroll();
    void persist();
  });
  $<HTMLInputElement>('optImages').addEventListener('change', (e) => {
    settings.options.images = (e.target as HTMLInputElement).checked;
    void persist();
  });

  $<HTMLInputElement>('optResponsive').addEventListener('change', (e) => {
    settings.options.responsive = (e.target as HTMLInputElement).checked;
    void persist();
  });

  $('capture').addEventListener('click', () => void start());
  $('lastCopy').addEventListener('click', (e) => void copy(e.currentTarget as HTMLButtonElement));
  $('doneCopy').addEventListener('click', (e) => void copy(e.currentTarget as HTMLButtonElement));
  $('lastDownload').addEventListener('click', () => void download());
  $('doneDownload').addEventListener('click', () => void download());
  $('again').addEventListener('click', async () => {
    const last = (await chrome.runtime.sendMessage({ type: 'webframe:getLast' })) as { summary: CaptureSummary | null };
    renderLast(last.summary);
    setState('idle');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'webframe:progress':
        setProgress(String(msg.stage), Number(msg.pct) || 0);
        break;
      case 'webframe:done':
        renderDone(msg.summary);
        break;
      case 'webframe:error':
        setState('idle');
        showError(msg.message);
        break;
      case 'webframe:cancelled':
        setState('idle');
        break;
    }
  });

  const last = (await chrome.runtime.sendMessage({ type: 'webframe:getLast' })) as { summary: CaptureSummary | null };
  renderLast(last.summary);
}

void init();
