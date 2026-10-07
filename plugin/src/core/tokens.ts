import { toHex } from '../../../shared/css';
import type { CaptureFile, LayerNode } from '../../../shared/schema';

const MAX_TOKENS = 24;

function tally(n: LayerNode, counts: Map<string, number>): void {
  const add = (hex: string) => counts.set(hex, (counts.get(hex) ?? 0) + 1);
  if (n.type === 'text') {
    if (n.color.a >= 0.99) add(toHex(n.color));
  } else if (n.type === 'frame') {
    for (const p of n.fills ?? []) if (p.type === 'solid' && p.color.a >= 0.99) add(toHex(p.color));
    n.children.forEach((c) => tally(c, counts));
  }
}

/**
 * Creates a local colour variable collection from the colours the page actually uses and
 * returns hex → Variable so the builder can bind fills to them.
 */
export function createColorTokens(file: CaptureFile): Map<string, Variable> {
  const out = new Map<string, Variable>();
  try {
    const counts = new Map<string, number>();
    tally(file.root, counts);
    const top = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TOKENS);
    if (top.length === 0) return out;

    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(file.source.url);
    const host = m ? m[1].replace(/^www\./, '') : 'page';
    const collection = figma.variables.createVariableCollection(`Web2Fig · ${host}`);
    top.forEach(([hex], i) => {
      const v = figma.variables.createVariable(`color/${String(i + 1).padStart(2, '0')}-${hex.slice(1)}`, collection, 'COLOR');
      const n = parseInt(hex.slice(1), 16);
      v.setValueForMode(collection.defaultModeId, { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 });
      out.set(hex, v);
    });
  } catch {
    // Variables unavailable on this plan / file – importing still works without them.
    out.clear();
  }
  return out;
}
