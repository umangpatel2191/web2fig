/**
 * One place for the product's name and mark, shared by the Chrome extension popup, the page toast and the Figma plugin.
 * (Internal ids — message types, the capture-file magic, the IndexedDB name — keep the old `webframe` spelling so
 * captures and settings made by earlier builds keep working.)
 */
export const BRAND = {
  name: 'Web2Fig',
  full: 'Web2Fig — Website to Figma',
  tagline: 'Website → editable Figma layers',
  extensionName: 'Web2Fig Capture',
} as const;

let uid = 0;

/**
 * The Web2Fig mark: a gradient tile holding four frame corners (the Figma "frame" gesture) around two stacked layers —
 * "a page becomes selectable layers". Drawn on a 64×64 grid; every shape is a plain primitive so it stays crisp at 16px.
 */
export function logoSvg(size = 32): string {
  const id = `w2f${uid++}`;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs>` +
    `<linearGradient id="${id}a" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse"><stop stop-color="#5B5CF6"/><stop offset="1" stop-color="#9B4DF0"/></linearGradient>` +
    `<linearGradient id="${id}b" x1="32" y1="0" x2="32" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<rect width="64" height="64" rx="15" fill="url(#${id}a)"/>` +
    `<rect width="64" height="64" rx="15" fill="url(#${id}b)"/>` +
    `<g stroke="#fff" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M17 27v-6a4 4 0 0 1 4-4h6"/><path d="M37 17h6a4 4 0 0 1 4 4v6"/>` +
    `<path d="M47 37v6a4 4 0 0 1-4 4h-6"/><path d="M27 47h-6a4 4 0 0 1-4-4v-6"/>` +
    `</g>` +
    `<rect x="25.5" y="25.5" width="14" height="14" rx="3.4" fill="#fff" fill-opacity=".5"/>` +
    `<rect x="29.5" y="29.5" width="14" height="14" rx="3.4" fill="#fff"/>` +
    `</svg>`
  );
}
