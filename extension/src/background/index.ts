import { DEFAULT_CAPTURE_OPTIONS, type CaptureMode, type CaptureOptions, type CaptureSummary } from '../../../shared/messages';
import type { CaptureFile } from '../../../shared/schema';
import { cropScreenshot, fetchAsset, makeThumbnail } from './assets';
import { loadLast, saveLast } from './store';

const PORT_NAME = 'webframe-capture';
const SETTINGS_KEY = 'settings';

interface Settings {
  mode: CaptureMode;
  options: CaptureOptions;
}
const DEFAULT_SETTINGS: Settings = { mode: 'full', options: DEFAULT_CAPTURE_OPTIONS };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function broadcast(msg: Record<string, unknown>): void {
  chrome.runtime.sendMessage(msg).catch(() => undefined); // popup may be closed
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Write the captured design to the clipboard.',
      });
    }
    const res = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text })) as { ok?: boolean } | undefined;
    return !!res?.ok;
  } catch {
    return false;
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function startCapture(mode: CaptureMode, options: CaptureOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: 'No active tab found.' };
  if (!/^(https?|file):/i.test(tab.url ?? '')) {
    return { ok: false, error: 'Chrome doesn’t allow extensions to read this kind of page. Open a regular website and try again.' };
  }
  if (options.responsive && mode !== 'element') return startResponsive(tab, mode, options);
  return injectAndStart(tab.id, mode, options);
}

type StartResult = { ok: true } | { ok: false; error: string };

async function injectAndStart(tabId: number, mode: CaptureMode, options: CaptureOptions): Promise<StartResult> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'webframe:start', mode, options });
    await chrome.action.setBadgeText({ text: '', tabId });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: /cannot access|extensions gallery|chrome web store/i.test(String(e))
        ? 'Chrome blocks extensions on this page (for example the Chrome Web Store). Try another site.'
        : `Could not start the capture: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Responsive set: the current window, then a 768px and a 390px popup  */
/* ------------------------------------------------------------------ */

interface Session {
  mode: CaptureMode;
  options: CaptureOptions;
  url: string;
  height: number;
  originWindowId: number;
  originTabId: number;
  /** Tab being captured right now. */
  tabId: number;
  targets: { name: string; width: number | null }[];
  idx: number;
  results: { json: string; summary: Omit<CaptureSummary, 'bytes' | 'copied' | 'at'> }[];
  notes: string[];
  tempWindowId?: number;
}
const sessions = new Map<number, Session>(); // keyed by the tab currently being captured
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sizeName = (w: number) => (w >= 1000 ? 'Desktop' : w >= 600 ? 'Tablet' : 'Mobile');

async function startResponsive(tab: chrome.tabs.Tab, mode: CaptureMode, options: CaptureOptions): Promise<StartResult> {
  const win = await chrome.windows.get(tab.windowId);
  const session: Session = {
    mode,
    options,
    url: tab.url ?? '',
    height: win.height ?? 900,
    originWindowId: tab.windowId,
    originTabId: tab.id!,
    tabId: tab.id!,
    targets: [
      { name: 'current', width: null },
      { name: 'tablet', width: 768 },
      { name: 'mobile', width: 390 },
    ],
    idx: 0,
    results: [],
    notes: [],
  };
  sessions.set(tab.id!, session);
  const started = await injectAndStart(tab.id!, mode, options);
  if (!started.ok) sessions.delete(tab.id!);
  return started;
}

function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(), () => undefined);
  });
}

async function closeTemp(session: Session): Promise<void> {
  const id = session.tempWindowId;
  session.tempWindowId = undefined;
  if (id !== undefined) await chrome.windows.remove(id).catch(() => undefined);
}

/** Opens the next size in a small popup window (normal windows can't be narrower than ~500px). */
async function openNextTarget(session: Session): Promise<void> {
  const target = session.targets[session.idx];
  try {
    broadcast({ type: 'webframe:progress', stage: `Opening the ${target.name} layout (${target.width}px)`, pct: 0.02 });
    const win = await chrome.windows.create({ url: session.url, type: 'popup', width: (target.width ?? 800) + 16, height: session.height, focused: true });
    if (!win || win.id === undefined) throw new Error('could not open a window');
    session.tempWindowId = win.id;
    const tabId = win.tabs?.[0]?.id;
    if (tabId === undefined) throw new Error('could not open a window');
    await waitForComplete(tabId, 45_000);
    await sleep(1400); // let the app boot and apply its media queries
    const [{ result: iw }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.innerWidth });
    if (typeof iw === 'number' && Math.abs(iw - (target.width ?? iw)) > 1) {
      const real = await chrome.windows.get(win.id);
      await chrome.windows.update(win.id, { width: (real.width ?? 0) + ((target.width ?? iw) - iw) });
      await sleep(700);
    }
    session.tabId = tabId;
    sessions.set(tabId, session);
    const started = await injectAndStart(tabId, session.mode, session.options);
    if (!started.ok) throw new Error(started.error);
  } catch (e) {
    await skipTarget(session, `${target.name} layout skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function skipTarget(session: Session, note: string): Promise<void> {
  session.notes.push(note);
  sessions.delete(session.tabId);
  await closeTemp(session);
  await advance(session);
}

async function advance(session: Session): Promise<void> {
  session.idx++;
  if (session.idx < session.targets.length) return openNextTarget(session);
  return finalizeResponsive(session);
}

async function finalizeResponsive(session: Session): Promise<void> {
  await chrome.windows.update(session.originWindowId, { focused: true }).catch(() => undefined);
  if (session.results.length === 0) {
    broadcast({ type: 'webframe:error', message: session.notes[0] ?? 'The capture failed.' });
    return;
  }
  const files = session.results.map((r) => JSON.parse(r.json) as CaptureFile);
  const widthOf = (f: CaptureFile) => Math.round(f.source?.viewport?.w ?? f.root.w);
  const base = files[0];
  base.label = `${sizeName(widthOf(base))} · ${widthOf(base)}`;
  base.breakpoints = files.slice(1).map((f) => {
    delete f.thumbnail; // only the main layout needs a preview
    const w = widthOf(f);
    return { label: `${sizeName(w)} · ${w}`, width: w, file: f };
  });
  const json = JSON.stringify(base);
  const first = session.results[0].summary;
  const summary: CaptureSummary = {
    ...first,
    title: `${first.title} · ${files.length} sizes`,
    layers: session.results.reduce((s, r) => s + r.summary.layers, 0),
    texts: session.results.reduce((s, r) => s + r.summary.texts, 0),
    images: session.results.reduce((s, r) => s + r.summary.images, 0),
    warnings: [...new Set([...session.results.flatMap((r) => r.summary.warnings), ...session.notes])],
    bytes: json.length,
    copied: false,
    at: Date.now(),
  };
  summary.copied = await copyToClipboard(json);
  await saveLast({ json, summary });
  await chrome.action.setBadgeBackgroundColor({ color: summary.copied ? '#22c55e' : '#f59e0b', tabId: session.originTabId }).catch(() => undefined);
  await chrome.action.setBadgeText({ text: summary.copied ? '✓' : '!', tabId: session.originTabId }).catch(() => undefined);
  broadcast({ type: 'webframe:done', summary });
}

chrome.windows.onRemoved.addListener((id) => {
  for (const s of sessions.values()) if (s.tempWindowId === id) void skipTarget(s, 'a layout window was closed before it finished');
});

async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { mode: stored?.mode ?? DEFAULT_SETTINGS.mode, options: { ...DEFAULT_CAPTURE_OPTIONS, ...stored?.options } };
}

/* ------------------------------------------------------------------ */
/* Capture sessions (content script → port)                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  let chunks: string[] = [];
  let finished = false;
  port.onDisconnect.addListener(() => {
    const s = tabId !== undefined ? sessions.get(tabId) : undefined;
    if (s && !finished && s.idx > 0) void skipTarget(s, 'a layout stopped responding');
  });

  const reply = (msg: Record<string, unknown>) => {
    try {
      port.postMessage(msg);
    } catch {
      /* page navigated away */
    }
  };

  port.onMessage.addListener(async (m) => {
    switch (m.type) {
      case 'progress': {
        const s = tabId !== undefined ? sessions.get(tabId) : undefined;
        if (!s) broadcast({ type: 'webframe:progress', stage: m.stage, pct: m.pct });
        else {
          const label = s.idx === 0 ? 'Desktop' : s.targets[s.idx].name === 'tablet' ? 'Tablet' : 'Mobile';
          broadcast({ type: 'webframe:progress', stage: `${label}: ${m.stage}`, pct: (s.idx + (Number(m.pct) || 0)) / s.targets.length });
        }
        break;
      }
      case 'chunk':
        chunks[m.index] = m.data;
        break;
      case 'cancelled':
        chunks = [];
        broadcast({ type: 'webframe:cancelled' });
        break;
      case 'error':
        chunks = [];
        broadcast({ type: 'webframe:error', message: m.message });
        break;
      case 'done': {
        const json = chunks.join('');
        chunks = [];
        finished = true;
        const session = tabId !== undefined ? sessions.get(tabId) : undefined;
        if (session) {
          // one size of a responsive set: keep it, then move on to the next size
          sessions.delete(tabId!);
          session.results.push({ json, summary: m.summary });
          reply({ type: 'finished', copied: false });
          await closeTemp(session);
          await advance(session);
          break;
        }
        const summary: CaptureSummary = { ...m.summary, bytes: json.length, copied: false, at: Date.now() };
        summary.copied = await copyToClipboard(json);
        await saveLast({ json, summary });
        if (tabId !== undefined) {
          await chrome.action.setBadgeBackgroundColor({ color: summary.copied ? '#22c55e' : '#f59e0b', tabId });
          await chrome.action.setBadgeText({ text: summary.copied ? '✓' : '!', tabId });
        }
        reply({ type: 'finished', copied: summary.copied });
        broadcast({ type: 'webframe:done', summary });
        break;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Messages from popup / content                                       */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'webframe:start':
      void startCapture(msg.mode, msg.options).then(sendResponse);
      return true;

    case 'webframe:fetchAsset':
      fetchAsset(msg.url).then(
        (asset) => sendResponse({ ok: true, asset }),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true;

    case 'webframe:thumbnail': {
      const windowId = sender.tab?.windowId;
      chrome.tabs
        .captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'jpeg', quality: 70 })
        .then(makeThumbnail)
        .then(
          (dataUrl) => sendResponse({ ok: true, dataUrl }),
          () => sendResponse({ ok: false }),
        );
      return true;
    }

    case 'webframe:captureRegion': {
      const windowId = sender.tab?.windowId;
      chrome.tabs
        .captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' })
        .then((url) => cropScreenshot(url, msg.rect, msg.dpr || 1))
        .then(
          (r) => sendResponse({ ok: true, ...r }),
          () => sendResponse({ ok: false }),
        );
      return true;
    }

    case 'webframe:getLast':
      loadLast().then((last) => sendResponse({ summary: last?.summary ?? null }));
      return true;

    case 'webframe:copyLast':
      loadLast().then(async (last) => sendResponse({ ok: last ? await copyToClipboard(last.json) : false }));
      return true;

    case 'webframe:downloadLast':
      loadLast().then((last) => sendResponse({ json: last?.json ?? null, summary: last?.summary ?? null }));
      return true;
  }
  return undefined;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-page') return;
  const { mode, options } = await getSettings();
  const res = await startCapture(mode, options);
  if (!res.ok) console.warn('[webframe]', res.error);
});
