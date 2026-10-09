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
 * The Web2Fig mark: a light cream tile with four maroon frame corners (the Figma "frame" gesture) around a `</>` glyph —
 * "a web page becomes a Figma frame". Drawn on a 64×64 grid; every shape is a plain primitive so it stays crisp at 16px.
 * (scripts/icons.mjs draws the same shapes for the PNG icons.)
 */
export function logoSvg(size = 32): string {
  const id = `w2f${uid++}`;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs>` +
    `<linearGradient id="${id}a" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse"><stop stop-color="#FFF9F0"/><stop offset="1" stop-color="#EFDFC8"/></linearGradient>` +
    `<linearGradient id="${id}b" x1="32" y1="0" x2="32" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<rect width="64" height="64" rx="15" fill="url(#${id}a)"/>` +
    `<rect width="64" height="64" rx="15" fill="url(#${id}b)"/>` +
    `<g stroke="#5A1E24" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M17 27v-6a4 4 0 0 1 4-4h6"/><path d="M37 17h6a4 4 0 0 1 4 4v6"/>` +
    `<path d="M47 37v6a4 4 0 0 1-4 4h-6"/><path d="M27 47h-6a4 4 0 0 1-4-4v-6"/>` +
    `</g>` +
    `<g stroke="#5A1E24" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M27.5 26L21.5 32l6 6"/><path d="M36.5 26l6 6-6 6"/><path d="M34 24l-4 16" stroke="#C9524A"/>` +
    `</g>` +
    `</svg>`
  );
}

/** Where people go for the extension and for help. Shown in the plugin, the popup and the store artwork. */
export const CONTACT = {
  email: 'umangp737@gmail.com',
  phone: '7600363306',
  edgeUrl: 'https://microsoftedge.microsoft.com/addons/detail/web2fig-%E2%80%94-website-to-figm/ofomamonipegnofpcemkadghleapoccd',
} as const;
