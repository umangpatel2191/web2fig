import type { CaptureSummary } from '../../../shared/messages';

/** Tiny IndexedDB wrapper: captures can be tens of MB, far beyond chrome.storage limits. */
const DB = 'webframe';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface LastCapture {
  json: string;
  summary: CaptureSummary;
}

export const saveLast = (v: LastCapture) => tx('readwrite', (s) => s.put(v, 'last'));
export const loadLast = () => tx<LastCapture | undefined>('readonly', (s) => s.get('last'));
