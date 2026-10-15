# Web2Fig — Website to Figma

**Web2Fig is a free Figma plugin and Microsoft Edge extension that converts a website into real, editable Figma layers**
(frames, text, images, SVG icons, gradients, masks, shadows, Auto Layout, text styles and color variables) instead of a flat screenshot.
Also searched as: web to Figma, HTML to Figma, website to Figma, URL to Figma, import website into Figma.

Built for designers who generate websites with AI (or receive them from developers) and want to refine them in Figma without rebuilding every section by hand.

## Two ways to import a website into Figma

1. **Paste a link.** Open the Web2Fig plugin in Figma, paste a website address, choose Desktop, Tablet, Mobile or all three sizes, press **Fetch design**, then **Import**. Works for public pages. The page is scrolled first so reveal animations and lazy images are included.
2. **Capture with the Edge extension.** Click the extension on any page, including pages behind a login, then press `Ctrl+V` (`⌘V` on Mac) in the plugin's **Paste capture** tab.

## Get it

- **Microsoft Edge extension:** [Web2Fig — Website to Figma on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/web2fig-%E2%80%94-website-to-figm/ofomamonipegnofpcemkadghleapoccd)
- **Figma plugin:** search for **Web2Fig — Website to Figma** in Figma's Plugins (Community listing in review). Until then, build it from source below.
- **Help:** umangp737@gmail.com

Two parts, both free:

| Part | What it does | Where |
|---|---|---|
| **Web2Fig Capture** (browser extension, Microsoft Edge; also loads in Chrome) | Reads the live page (positions, computed styles, exact text line-breaks, images) and copies a capture to your clipboard | `dist/extension` |
| **Web2Fig** (Figma plugin) | Builds the layers from a link or from a capture | `dist/plugin` |

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
2. Web2Fig captures the **full page**, top to bottom. The result is copied to your clipboard automatically.
3. In Figma run **Plugins → Development → Web2Fig**, press `⌘V` / `Ctrl+V`, review the preview, hit **Import**.

If the clipboard is blocked, use **Download .json** in the popup and drop the file into the plugin.

## Animated sites

Content that animates in (reveal-on-scroll, lazy images) only exists once it has played. For best results:

1. Keep **Scroll through the page first** on. Web2Fig scrolls the whole page in small steps, waits for every animation to finish,
   pauses at the bottom, scrolls back up, then captures. **There is no time limit**: it goes until it reaches the real bottom.
2. **Scroll pace**: *Balanced* suits most sites. Pick *Thorough* for heavy scroll-driven pages (it scrolls in smaller steps and waits longer).
3. Or scroll through the whole page yourself, slowly, then capture (turn the option off to skip the auto-scroll).
4. Elements that are still invisible (`opacity: 0`) at capture time are skipped, and finite CSS/Web animations are jumped to their end state first.

Scroll-*scrubbed* animations (GSAP ScrollTrigger `scrub`, pinned sections) are driven by the scroll position and snap back when you return to the
top, so those sections can still capture in their starting state. Use the **Scroll pace: Thorough** option, or scroll the page yourself first, for those sections.

## Capture different breakpoints

Resize the browser window (or use DevTools device mode) and capture again — each capture is one viewport width.

## From a link (paste a link in the plugin)

This version of the plugin has a **From a link** tab: paste a website address, click **Fetch design**, and the layers appear — no browser extension needed.
A plugin cannot render a page itself, so the plugin asks a small **Web2Fig server** to open the link in a hidden Chrome and run the same capture engine.

- **Hosted (default build):** the server runs for free on a Hugging Face **Gradio Space** (see `space-template/` and `npm run build:space`). `app.py` starts the Node server (`helper/server.ts`), which fetches its own Chrome on first start.
- **Local:** `npm run build -- --helper-url=http://localhost:5810`, then run `dist/helper/Start Web2Fig Helper.bat`. It uses your own Chrome and has no limits.

The hosted server refuses links to private networks, rate-limits each visitor, and only accepts calls from the Figma plugin. It cannot capture pages behind a login, and some sites block servers: use the browser extension for those.

Build options: `npm run build` (hosted), `npm run build:local`, `npm run build:paste` (no link tab, no network), `npm run build:space` (the Space bundle).

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
- Layer names designers can navigate (`Button · Speak to us`, `Image · hero-laptop`, `Section · pricing`), text outlines, `line-clamp` / ellipsis truncation
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

## FAQ

**What is Web2Fig?** A free Figma plugin and Microsoft Edge extension that converts a website into editable Figma layers, with real text, images, SVG and Auto Layout, instead of a screenshot.

**How do I import a website into Figma?** Open the Web2Fig plugin, paste the website address, choose a size and press Fetch design. Or capture the page with the Edge extension and paste it into the plugin's Paste capture tab.

**Does it work for pages behind a login?** Yes, with the Edge extension, because it captures the page open in your own browser. Paste-a-link only opens public pages.

**Can I turn an AI-generated website into Figma layers?** Yes. Paste the site's public link, or capture it with the extension, then edit the layers in Figma. Complex animations and highly dynamic apps may not match the original exactly (see Known limits).

**Is it free? Do I need an account?** It is free and needs no account. The free link-import server limits how many captures each visitor can run per hour.

**Is my data private?** Paste capture stays on your computer. Paste-a-link sends only the website address and size to the Web2Fig server, which does not store them. There is no tracking. See [PRIVACY.md](PRIVACY.md).

**Does it support responsive layouts?** Yes. Choose All 3 sizes to import desktop, tablet and mobile side by side.

**Is there a Chrome version?** The extension is published for Microsoft Edge today; the same build also loads in Chrome from `dist/extension` (Developer mode). Paste-a-link works without any extension.

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
