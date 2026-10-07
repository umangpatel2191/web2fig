import type { FontSpec, FontUsage } from '../../../shared/schema';
import { FontIndex, type FontName } from './font-match';

export interface Substitution {
  requested: string;
  used: string;
  count: number;
}

const keyOf = (f: FontSpec) => `${f.families.join('|')}::${f.weight}::${f.italic}`;

/** Resolves CSS fonts to Figma fonts, loads them, and remembers what had to be substituted. */
export class FontResolver {
  private index!: FontIndex;
  private cache = new Map<string, FontName>();
  private subs = new Map<string, Substitution>();

  async init(): Promise<void> {
    const list = await figma.listAvailableFontsAsync();
    this.index = new FontIndex(list.map((f) => ({ family: f.fontName.family, style: f.fontName.style })));
  }

  resolve(spec: FontSpec): FontName {
    const key = keyOf(spec);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const { font, missing } = this.index.match(spec.families, spec.weight, spec.italic);
    this.cache.set(key, font);
    if (missing) {
      const s = this.subs.get(missing) ?? { requested: missing, used: font.family, count: 0 };
      s.count++;
      this.subs.set(missing, s);
    }
    return font;
  }

  /** Loads every distinct font up front; falls back to Inter if one fails to load. */
  async preload(specs: Iterable<FontSpec>): Promise<void> {
    const seen = new Set<string>();
    for (const spec of specs) {
      const key = keyOf(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      const font = this.resolve(spec);
      try {
        await figma.loadFontAsync(font);
      } catch {
        const fallback = { family: 'Inter', style: spec.italic ? 'Italic' : 'Regular' };
        await figma.loadFontAsync(fallback);
        this.cache.set(key, fallback);
      }
    }
  }

  /** True when the font Figma will use isn't the one the page asked for. */
  isSubstituted(spec: FontSpec): boolean {
    const { missing } = this.index.match(spec.families, spec.weight, spec.italic);
    return !!missing;
  }

  substitutions(usage: FontUsage[]): Substitution[] {
    const counts = new Map(usage.map((u) => [u.family, u.count]));
    return [...this.subs.values()].map((s) => ({ ...s, count: counts.get(s.requested) ?? s.count }));
  }
}
