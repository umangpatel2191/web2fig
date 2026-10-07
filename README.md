# Web2Fig — Website to Figma

Capture any website as **real, editable Figma layers** (frames, text, images, SVG, gradients, shadows,
Auto Layout, color variables), not a flat screenshot. Also known as: web to Figma, HTML to Figma, website to Figma, URL to Figma.

Two parts, both free to run locally:

| Part | What it does | Where |
|---|---|---|
| **Web2Fig Capture** (Chrome extension) | Reads the live page (positions, computed styles, exact text line-breaks, images) and copies a capture to your clipboard | `dist/extension` |
| **Web2Fig** (Figma plugin) | Reads the capture and builds the layers in your file | `dist/plugin` |

## Install (≈2 minutes, $0)

Requirements: Node 20+, Chrome 116+, the **Figma desktop app** (free account is fine).

```bash
npm install
npm run build
```

**Extension** — open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked*, choose `dist/extension`.
Pin it from the puzzle-piece menu.

**Plugin** — in the Figma desktop app: *Plugins → Development → Import plugin from manifest…* and pick
`dist/plugin/manifest.json`.

## Use

1. Open any website, click the **Web2Fig** icon (or press `Alt+Shift+C`).
2. Pick a mode — **Full page**, **Visible**, or **Pick element** (hover + click; `↑`/`↓` select parent/child).
3. Click capture. The result is copied to your clipboard automatically.
4. In Figma run **Plugins → Development → Web2Fig**, press `⌘V` / `Ctrl+V`, review the preview, hit **Import**.

If the clipboard is blocked, use **Download .json** in the popup and drop the file into the plugin.

## Animated sites

Content that animates in (reveal-on-scroll, lazy images) only exists once it has played. For best results:

1. Keep **Scroll through the page first** on. Web2Fig scrolls the whole page in small steps, waits for every animation to finish,
   pauses at the bottom, scrolls back up, then captures. **There is no time limit**: it goes until it reaches the real bottom.
2. **Scroll pace**: *Balanced* suits most sites. Pick *Thorough* for heavy scroll-driven pages (it scrolls in smaller steps and waits longer).
3. Or scroll through the whole page yourself, slowly, then capture (turn the option off to skip the auto-scroll).
4. Elements that are still invisible (`opacity: 0`) at capture time are skipped, and finite CSS/Web animations are jumped to their end state first.

Scroll-*scrubbed* animations (GSAP ScrollTrigger `scrub`, pinned sections) are driven by the scroll position and snap back when you return to the
top, so those sections can still capture in their starting state. Capture those pieces one by one with **Pick element** while the section is on screen.

## Capture different breakpoints

Resize the browser window (or use DevTools device mode) and capture again — each capture is one viewport width.

## From a link (local helper) — optional, off by default

Build with link mode using `npm run build:link` (a normal `npm run build` leaves it out).

The plugin has a **From a link** tab: paste a website address, click **Fetch design**, and the layers appear. A plugin cannot render a web
page by itself, so this uses a small **helper** that runs on your own computer and drives your own Chrome (hidden), with the same capture
engine as the extension.

1. Start the helper: run `dist/helper/Start Web2Fig Helper.bat` (Mac: `start-web2fig-helper.command`), or `npm run helper` from the repo. Leave it open.
2. In Figma: Plugins → Development → Web2Fig → **From a link**. A green "Helper connected" shows when it is found.

It listens on `localhost:5810` only and refuses requests that come from web pages. It cannot capture pages behind a login, and some sites block
automated browsers (use the extension for those). Figma only allows a plugin to talk to `localhost` when it is loaded from a manifest
(**Import plugin from manifest…**), so this mode is **not** part of the store release: see the `release/store` branch.

## Responsive set

Turn on **Responsive set** in the popup to capture the page at its current size plus a 768px (tablet) and a 390px (mobile) layout.
Web2Fig opens each extra size in a small popup window (Chrome will not shrink a normal window below ~500px), captures it, closes it,
and imports all sizes side by side in Figma, named like `Mobile · 390`.

## What is captured

- Frames with backgrounds, linear/radial gradients, per-side borders, per-corner radius, box/text shadows, opacity,
  blend modes, blur and backdrop blur, `overflow: hidden` clipping
- Text with **the browser's exact line breaks**, font family/weight/style, size, line-height, letter-spacing,
  alignment, decoration, text-transform, gradient text. Inline runs that continue a line after another element are placed at the right x.
  When a web font isn't in Figma the fallback font is letter-spaced so each line ends where it did in the browser
- **Paint order like the browser**: z-index, positioned elements, stacking contexts. Negative z-index overlays go behind the content,
  fixed headers, dropdowns and overlays go in front, even when they live in a different part of the DOM tree
- **Transforms** (rotate / scale / skew / translate, also the individual `rotate`/`scale`/`translate` properties, nested) become real Figma layer transforms
- `::before` / `::after` — in-flow text, decorations, rotated and z-indexed ones (they are measured as real nodes, then removed again)
- Backgrounds: sized, positioned (`right 10px bottom 10px`), repeated (`repeat`, `repeat-x/y`, `space`, `round`), tiled SVG and CSS-gradient patterns
  (grids, dots, stripes) as one native tiled fill, several layers in the right order
- `<img>`, `<canvas>`, `<video>` frame, inline `<svg>` (incl. `<use>`), **same-origin iframes (their content is captured)**,
  icon fonts (Font Awesome, Material Icons …) drawn as images
- **Cross-origin iframes, tainted/WebGL canvases and videos** are captured as a screenshot of the element (they must fit on screen)
- Form controls (values/placeholders, native checkbox / radio), list markers, open shadow DOM
- Smart Auto Layout: rows, columns and **wrapping grids** are converted **only** when Figma reproduces the original positions within 2px; full-width children get `Fill`, otherwise the
  frame stays absolute so the design remains pixel-accurate. Resize **constraints** (centre / right / stretch) are inferred from where each layer sits
- Layer names designers can navigate (`Button · Speak to us`, `Image · hero-laptop`, `Section · pricing`), **clickable links** on text, text outlines, `line-clamp` / ellipsis truncation
- `clip-path` shapes (polygon, circle, ellipse, inset, path) and `mask-image` gradients as native **Figma masks**; conic and repeating gradients drawn by the browser itself
- **Text styles** for typography that repeats, colour variables, an option to import onto a **new page**
- Color variables created from the page palette and bound to fills

## Known limits (be aware)

- Fonts: Figma needs the font. Missing ones fall back to the closest available font (letter-spaced to the browser's width) and are listed after import.
- 3D transforms are flattened to 2D. SVG `clip-path: url(#id)` and image masks are ignored; colour filters (brightness, grayscale…) are ignored.
- CSS `counter()` numbers in `::before/::after` and `content: url()` images are not captured (reported in the notes).
- Inline backgrounds that wrap over several lines are drawn as one box; `object-position` other than centred is not applied.
- More than 10 cross-origin embeds, or ones taller than the window, stay placeholders.
- Scroll-scrubbed animations (see above). Very large pages stop at 30,000 layers.
- Pages behind logins work (you capture your own logged-in tab).
- Respect copyright and trademarks: use it on your own sites, for audits and for inspiration.

## Develop

```bash
npm run watch       # rebuild on change (reload the extension card / re-run the plugin)
npm run typecheck   # strict TypeScript for extension, plugin main and plugin UI
npm test            # unit tests (CSS parsing, gradients, Auto Layout, font matching, importer vs. mock Figma)
npm run check       # all of the above + production build
npm run qa          # real-browser test page: node qa/server.mjs → http://localhost:5179/pages/test.html
```

`qa/` runs the real capture code in a normal page (no extension needed) and has `__capture()` / `__replay()` helpers that redraw the capture as HTML,
so you can compare the page with its capture side by side (z-order, text, backgrounds, transforms).

```
shared/            capture format (schema.ts), CSS parsers (css.ts), message types
extension/src/
  content/         DOM walker, text line scanner, SVG serializer, picker, toast
  background/      image downloader (CORS-free), clipboard bridge, IndexedDB store
  popup/           popup UI
plugin/src/
  core/            importer, Auto Layout planner, font matching, paints, color tokens
  ui/              plugin window
```

## Store listing (suggested)

- **Chrome Web Store name:** Web2Fig — Website to Figma
- **Short description:** Capture any website as editable Figma layers: real frames, text, images, SVG and Auto Layout.
- **Figma Community name:** Web2Fig — Website to Figma
- **Keywords:** web to figma, website to figma, html to figma, url to figma, import website, copy website, design from website, web capture

## Publishing later (optional)

- Chrome Web Store: one-time $5 developer fee. The `<all_urls>` host permission is required to download cross-origin images.
- Figma Community: free; set a real plugin `id` in `plugin/manifest.json`. Plugin review typically takes days.
