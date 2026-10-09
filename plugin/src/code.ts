import { DEFAULT_IMPORT_OPTIONS, type ImportOptions, type MainToUi, type UiToMain } from '../../shared/messages';
import { CancelledError, importCapture } from './core/builder';

figma.showUI(__html__, { width: 400, height: 720, themeColors: true, title: 'Web2Fig' });

const post = (msg: MainToUi) => figma.ui.postMessage(msg);
let cancelled = false;
let busy = false;

figma.ui.onmessage = async (msg: UiToMain) => {
  switch (msg.type) {
    case 'ready': {
      const saved = (await figma.clientStorage.getAsync('options')) as Partial<ImportOptions> | undefined;
      post({ type: 'settings', options: { ...DEFAULT_IMPORT_OPTIONS, ...saved } });
      break;
    }
    case 'saveSettings':
      await figma.clientStorage.setAsync('options', msg.options);
      break;
    case 'notify':
      figma.notify(msg.text);
      break;
    case 'cancel':
      cancelled = true;
      break;
    case 'import': {
      if (busy) return;
      busy = true;
      cancelled = false;
      try {
        const result = await importCapture(msg.capture, msg.options, {
          progress: (done, total, stage) => post({ type: 'progress', done, total, stage }),
          cancelled: () => cancelled,
        });
        post({ type: 'done', result });
        figma.notify(`Web2Fig: imported ${result.layers.toLocaleString()} layers`);
      } catch (e) {
        if (e instanceof CancelledError) post({ type: 'cancelled' });
        else post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        busy = false;
      }
      break;
    }
  }
};
