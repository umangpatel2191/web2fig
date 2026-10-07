/**
 * Pure font matching: maps a CSS font stack + weight + italic onto the fonts Figma has.
 * No Figma API here so it can be unit-tested in Node.
 */
export interface FontName {
  family: string;
  style: string;
}

export interface Match {
  font: FontName;
  /** First non-generic family from the CSS stack that Figma did not have (if any). */
  missing?: string;
}

/** CSS generics / system stacks that have no single Figma equivalent. */
const SANS = new Set(['sans-serif', 'system-ui', 'ui-sans-serif', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'helvetica neue', 'helvetica', 'arial']);
const SERIF = ['georgia', 'times new roman', 'noto serif', 'playfair display'];
const MONO = ['roboto mono', 'menlo', 'sf mono', 'source code pro', 'courier new', 'jetbrains mono'];
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont']);

export function styleWeight(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]/g, '');
  if (/extrablack|ultrablack/.test(s)) return 900;
  if (/black|heavy/.test(s)) return 900;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/semibold|demibold/.test(s)) return 600;
  if (/bold/.test(s)) return 700;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/hairline|thin/.test(s)) return 100;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  return 400;
}

export const styleItalic = (style: string): boolean => /italic|oblique/i.test(style);

export function pickStyle(styles: string[], weight: number, italic: boolean): string | null {
  if (styles.length === 0) return null;
  let best: { style: string; score: number } | null = null;
  for (const style of styles) {
    const score = Math.abs(styleWeight(style) - weight) + (styleItalic(style) === italic ? 0 : 1000);
    if (!best || score < best.score) best = { style, score };
  }
  return best!.style;
}

export class FontIndex {
  private families = new Map<string, { family: string; styles: string[] }>();

  constructor(available: FontName[]) {
    for (const f of available) {
      const key = f.family.toLowerCase();
      const entry = this.families.get(key) ?? { family: f.family, styles: [] };
      entry.styles.push(f.style);
      this.families.set(key, entry);
    }
  }

  has(family: string): boolean {
    return this.families.has(family.toLowerCase());
  }

  private tryFamily(family: string, weight: number, italic: boolean): FontName | null {
    const entry = this.families.get(family.toLowerCase());
    if (!entry) return null;
    const style = pickStyle(entry.styles, weight, italic);
    return style ? { family: entry.family, style } : null;
  }

  match(families: string[], weight: number, italic: boolean): Match {
    let missing: string | undefined;
    for (const raw of families) {
      const fam = raw.toLowerCase();
      const hit = this.tryFamily(fam, weight, italic);
      if (hit) return { font: hit, missing };
      if (!GENERIC.has(fam) && !SANS.has(fam) && !missing) missing = raw;
    }
    const lower = families.map((f) => f.toLowerCase());
    const wantsMono = lower.includes('monospace') || lower.includes('ui-monospace');
    const wantsSerif = lower.includes('serif') && !lower.includes('sans-serif');
    const candidates = wantsMono ? MONO : wantsSerif ? SERIF : [];
    for (const c of candidates) {
      const hit = this.tryFamily(c, weight, italic);
      if (hit) return { font: hit, missing };
    }
    return { font: this.tryFamily('inter', weight, italic) ?? { family: 'Inter', style: italic ? 'Italic' : 'Regular' }, missing };
  }
}
