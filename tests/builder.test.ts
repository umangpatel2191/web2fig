/**
 * Smoke test for the Figma importer against a small mock of the Figma API.
 * The mock re-implements just enough Auto Layout to exercise the verify/revert logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC, SCHEMA_VERSION, type CaptureFile, type FrameNode } from '../shared/schema.ts';

class MockNode {
  type = 'FRAME';
  name = '';
  x = 0;
  y = 0;
  width = 1;
  height = 1;
  children: MockNode[] = [];
  parent: MockNode | null = null;
  fills: unknown[] = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  strokes: unknown[] = [];
  effects: unknown[] = [];
  opacity = 1;
  clipsContent = true;
  layoutPositioning = 'AUTO';
  private _mode = 'NONE';
  private pad = { t: 0, r: 0, b: 0, l: 0 };
  private _gap = 0;
  private _counter = 'MIN';
  characters = '';
  fontSize = 12;
  textAutoResize = 'NONE';
  removed = false;

  get layoutMode() { return this._mode; }
  set layoutMode(v: string) { this._mode = v; this.relayout(); }
  set itemSpacing(v: number) { this._gap = v; this.relayout(); }
  set paddingTop(v: number) { this.pad.t = v; this.relayout(); }
  set paddingRight(v: number) { this.pad.r = v; this.relayout(); }
  set paddingBottom(v: number) { this.pad.b = v; this.relayout(); }
  set paddingLeft(v: number) { this.pad.l = v; this.relayout(); }
  set counterAxisAlignItems(v: string) { this._counter = v; this.relayout(); }
  primaryAxisSizingMode = 'AUTO';
  counterAxisSizingMode = 'AUTO';
  primaryAxisAlignItems = 'MIN';

  resize(w: number, h: number) { this.width = w; this.height = h; this.relayout(); }
  appendChild(c: MockNode) { c.parent = this; this.children.push(c); this.relayout(); }
  insertChild(i: number, c: MockNode) { c.parent = this; this.children.splice(i, 0, c); }
  remove() { this.removed = true; this.parent?.children.splice(this.parent.children.indexOf(this), 1); }

  relayout() {
    if (this.type === 'TEXT' && this.textAutoResize === 'WIDTH_AND_HEIGHT') {
      const lines = this.characters.split('\n');
      this.width = Math.max(...lines.map((l) => l.length)) * this.fontSize * 0.5;
    }
    if (this._mode === 'NONE') return;
    const horiz = this._mode === 'HORIZONTAL';
    let cursor = horiz ? this.pad.l : this.pad.t;
    for (const c of this.children) {
      if (c.layoutPositioning === 'ABSOLUTE') continue;
      if (horiz) {
        c.x = cursor;
        c.y = this._counter === 'MIN' ? this.pad.t : this._counter === 'MAX' ? this.height - this.pad.b - c.height : this.pad.t + (this.height - this.pad.t - this.pad.b - c.height) / 2;
        cursor += c.width + this._gap;
      } else {
        c.y = cursor;
        c.x = this._counter === 'MIN' ? this.pad.l : this._counter === 'MAX' ? this.width - this.pad.r - c.width : this.pad.l + (this.width - this.pad.l - this.pad.r - c.width) / 2;
        cursor += c.height + this._gap;
      }
    }
  }
}

class MockText extends MockNode {
  override type = 'TEXT';
  fontName: unknown;
  textStyleId = '';
  async setTextStyleIdAsync(id: string) { this.textStyleId = id; }
  lineHeight: unknown;
  letterSpacing: unknown;
  textAlignHorizontal = 'LEFT';
  textDecoration = 'NONE';
}

const page = new MockNode();
(globalThis as any).figma = {
  currentPage: Object.assign(page, { selection: [] as unknown[] }),
  viewport: { center: { x: 500, y: 400 }, scrollAndZoomIntoView: () => undefined },
  createFrame: () => new MockNode(),
  createText: () => new MockText(),
  createTextStyle: () => ({ id: 'S:' + Math.random(), name: '', fontName: null, fontSize: 0, lineHeight: null, letterSpacing: null, textDecoration: 'NONE' }),
  getLocalTextStylesAsync: async () => [] as unknown[],
  createRectangle: () => Object.assign(new MockNode(), { type: 'RECTANGLE' }),
  createEllipse: () => Object.assign(new MockNode(), { type: 'ELLIPSE' }),
  createVector: () => Object.assign(new MockNode(), { type: 'VECTOR', vectorPaths: [] as unknown[] }),
  mixed: Symbol('mixed'),
  createNodeFromSvg: (svg: string) => {
    if (svg.includes('BROKEN')) throw new Error('bad svg');
    const n = new MockNode();
    const m = /width="([\d.]+)" height="([\d.]+)"/.exec(svg)!;
    n.width = +m[1];
    n.height = +m[2];
    return n;
  },
  createImage: () => ({ hash: 'hash123' }),
  base64Decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
  listAvailableFontsAsync: async () => ['Regular', 'Bold'].map((style) => ({ fontName: { family: 'Inter', style } })),
  loadFontAsync: async () => undefined,
  variables: {
    createVariableCollection: () => ({ defaultModeId: 'm' }),
    createVariable: () => ({ setValueForMode: () => undefined }),
    setBoundVariableForPaint: (p: unknown) => ({ ...(p as object), bound: true }),
  },
};

const { importCapture } = await import('../plugin/src/core/builder.ts');

const white = { r: 1, g: 1, b: 1, a: 1 };
const dark = { r: 0.1, g: 0.1, b: 0.1, a: 1 };
const font = { families: ['Inter'], size: 16, weight: 400, italic: false, lineHeight: 24, letterSpacing: 0, align: 'left' as const, decoration: 'none' as const };

const card = (x: number, label: string): FrameNode => ({
  type: 'frame', name: 'card', x, y: 0, w: 100, h: 60, fills: [{ type: 'solid', color: dark }], radius: [8, 8, 8, 8],
  children: [{ type: 'text', name: label, x: 10, y: 18, w: 40, h: 24, text: label, font, color: white }],
});

function capture(): CaptureFile {
  return {
    magic: MAGIC, version: SCHEMA_VERSION, tool: { name: 't', version: '0' },
    source: { url: 'https://example.com/', title: 'Example', capturedAt: '', mode: 'full', viewport: { w: 400, h: 200 }, dpr: 1 },
    root: {
      type: 'frame', name: 'root', x: 0, y: 0, w: 400, h: 300, clip: true, fills: [{ type: 'solid', color: white }],
      children: [
        // A row Figma can reproduce exactly (equal 16px gaps)
        { type: 'frame', name: 'row', x: 20, y: 20, w: 360, h: 60, children: [card(0, 'A'), card(116, 'B'), card(232, 'C')] },
        // A row with uneven gaps → must stay absolute
        { type: 'frame', name: 'uneven', x: 20, y: 100, w: 360, h: 60, children: [card(0, 'A'), card(110, 'B'), card(250, 'C')] },
        // Gradient, stroke, shadow, image + svg background, an absolute badge
        {
          type: 'frame', name: 'hero', x: 20, y: 180, w: 360, h: 100,
          fills: [
            { type: 'linear', angle: 135, stops: [{ pos: 0, color: dark }, { pos: 1, color: white }] },
            { type: 'image', asset: 'img', fit: 'fill' },
            { type: 'image', asset: 'vec', fit: 'fit' },
          ],
          stroke: { top: 1, right: 1, bottom: 1, left: 1, color: dark, dash: 'dashed' },
          shadows: [{ inset: false, x: 0, y: 4, blur: 12, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.2 } }],
          children: [
            { type: 'svg', name: 'icon', x: 10, y: 10, w: 24, h: 24, svg: '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>' },
            { type: 'svg', name: 'broken', x: 40, y: 10, w: 24, h: 24, svg: '<svg>BROKEN</svg>' },
            { type: 'frame', name: 'badge', x: 300, y: 8, w: 50, h: 20, abs: true, opacity: 0.8, fills: [{ type: 'solid', color: dark }], children: [] },
          ],
        },
      ],
    },
    assets: {
      img: { kind: 'raster', mime: 'image/png', data: 'iVBORw0KGgo=', w: 1, h: 1 },
      vec: { kind: 'svg', svg: '<svg width="10" height="10"><rect/></svg>' },
    },
    fonts: [{ family: 'Inter', weights: [400], italic: false, count: 6 }],
    stats: { layers: 0, texts: 0, images: 1, svgs: 1 },
    warnings: ['example warning'],
  };
}

const hooks = { progress: () => undefined, cancelled: () => false };
const opts = { autoLayout: true, images: true, variables: true };

test('imports a full capture and reports sensible stats', async () => {
  const res = await importCapture(capture(), opts, hooks);
  const root = page.children[0];
  assert.ok(root, 'root frame was added to the page');
  assert.equal(root.x, 500 - 200);
  assert.equal(res.images, 1);
  assert.equal(res.warnings.includes('example warning'), true);
  assert.ok(res.warnings.some((w) => /SVG/.test(w)), 'broken svg is reported');
  assert.equal(res.substitutions.length, 0);
});

test('Auto Layout applies only where it reproduces the original positions', async () => {
  page.children.length = 0;
  const res = await importCapture(capture(), opts, hooks);
  const root = page.children[0];
  const row = root.children.find((c) => c.name === 'row')!;
  const uneven = root.children.find((c) => c.name === 'uneven')!;
  assert.equal(row.layoutMode, 'HORIZONTAL');
  assert.deepEqual(row.children.map((c) => c.x), [0, 116, 232]);
  assert.equal(uneven.layoutMode, 'NONE');
  assert.deepEqual(uneven.children.map((c) => c.x), [0, 110, 250]);
  assert.ok(res.autoLayouts >= 1);
});

test('absolute children stay put inside Auto Layout frames; options respected', async () => {
  page.children.length = 0;
  await importCapture(capture(), { ...opts, autoLayout: false }, hooks);
  const hero = page.children[0].children.find((c) => c.name === 'hero')!;
  assert.equal(hero.layoutMode, 'NONE');
  assert.equal(hero.children.find((c) => c.name === 'badge')!.opacity, 0.8);
  assert.equal(page.children[0].children.find((c) => c.name === 'row')!.layoutMode, 'NONE');
});

test('frames without fills get an explicit empty fill list (Figma defaults to white)', async () => {
  page.children.length = 0;
  await importCapture(capture(), opts, hooks);
  const row = page.children[0].children.find((c) => c.name === 'row')!;
  assert.deepEqual(row.fills, []);
});

test('cancelling removes the partial import', async () => {
  page.children.length = 0;
  let calls = 0;
  await assert.rejects(importCapture(capture(), opts, { progress: () => undefined, cancelled: () => ++calls > 3 }));
  assert.equal(page.children.length, 0);
});

test('turning images off drops raster fills but keeps the layout', async () => {
  page.children.length = 0;
  const res = await importCapture(capture(), { ...opts, images: false }, hooks);
  assert.equal(res.images, 0);
});

test("transforms, tiled paints, gradient text and substituted fonts are applied", async () => {
  page.children.length = 0;
  const file = capture();
  const root = file.root;
  root.children.push({
    type: "frame", name: "rotated", x: 10, y: 10, w: 80, h: 40, rel: [0.866, 0.5, -0.5, 0.866, 40, 12],
    fills: [{ type: "image", asset: "img", fit: "tile", tile: { w: 20, h: 20 } }],
    children: [{
      type: "text", name: "grad", x: 0, y: 0, w: 100, h: 24, text: "Gradient", font: { ...font, families: ["Brand Sans", "Inter"] }, color: dark,
      paint: { type: "linear", angle: 90, stops: [{ pos: 0, color: dark }, { pos: 1, color: white }] },
    }],
  });
  await importCapture(file, opts, hooks);
  const rotated = page.children[0].children.find((c) => c.name === "rotated")!;
  assert.deepEqual((rotated as any).relativeTransform, [[0.866, -0.5, 40], [0.5, 0.866, 12]]);
  assert.equal((rotated.fills[0] as any).scaleMode, "TILE");
  assert.equal((rotated.fills[0] as any).scalingFactor, 20);
  const text = rotated.children[0] as any;
  assert.equal(text.fills[0].type, "GRADIENT_LINEAR");
  // Brand Sans isn't in Figma: the width is matched to the browser's by adjusting letter-spacing.
  assert.notEqual(text.letterSpacing.value, 0);
});

test('clip-path / mask-image become a mask layer with the frame paint moved above it', async () => {
  page.children.length = 0;
  const file = capture();
  file.root.children.push(
    {
      type: 'frame', name: 'triangle', x: 0, y: 0, w: 100, h: 100, fills: [{ type: 'solid', color: dark }],
      clipShape: { kind: 'poly', pts: [[50, 0], [100, 100], [0, 100]] },
      children: [{ type: 'text', name: 'label', x: 10, y: 10, w: 40, h: 24, text: 'Hi', font, color: white }],
    },
    {
      type: 'frame', name: 'fade', x: 0, y: 120, w: 100, h: 60, fills: [{ type: 'solid', color: dark }],
      mask: { type: 'linear', angle: 180, stops: [{ pos: 0, color: dark }, { pos: 1, color: { ...dark, a: 0 } }] }, children: [],
    },
    { type: 'frame', name: 'circle', x: 0, y: 200, w: 80, h: 80, fills: [{ type: 'solid', color: dark }], clipShape: { kind: 'ellipse', cx: 40, cy: 40, rx: 40, ry: 40 }, children: [] },
  );
  await importCapture(file, opts, hooks);
  const root = page.children[0];
  const tri = root.children.find((c) => c.name === 'triangle')!;
  assert.equal(tri.children[0].name, 'mask');
  assert.equal((tri.children[0] as any).isMask, true);
  assert.equal((tri.children[0] as any).vectorPaths[0].data, 'M 50 0 L 100 100 L 0 100 Z');
  assert.equal(tri.children[1].name, 'surface');
  assert.equal((tri.children[1].fills as any[]).length, 1, 'frame paint moved to the surface');
  assert.deepEqual(tri.fills, [], 'frame itself no longer paints (it would sit under the mask)');
  assert.equal(tri.children[2].type, 'TEXT', 'content stays above the mask');
  const fade = root.children.find((c) => c.name === 'fade')!;
  assert.equal((fade.children[0] as any).isMask, true);
  const circle = root.children.find((c) => c.name === 'circle')!;
  assert.equal(circle.children[0].type, 'ELLIPSE');
});

test('repeated typography gets a shared text style; one-off typography does not', async () => {
  page.children.length = 0;
  const file = capture();
  const rep = (label: string) => ({ type: 'text' as const, name: label, x: 0, y: 0, w: 60, h: 24, text: label, font: { ...font, size: 18, lineHeight: 28 }, color: dark });
  file.root.children.push(
    { type: 'frame', name: 'texts', x: 0, y: 400, w: 300, h: 100, children: [rep('One'), rep('Two'), rep('Three'), { type: 'text', name: 'solo', x: 0, y: 40, w: 60, h: 24, text: 'Solo', font: { ...font, size: 31, lineHeight: 40 }, color: dark }] },
  );
  await importCapture(file, { ...opts, textStyles: true }, hooks);
  const texts = page.children[0].children.find((c) => c.name === 'texts')!;
  const styled = texts.children.filter((c: any) => c.textStyleId);
  assert.equal(styled.length, 3, 'the three 18/28 texts share a style');
  assert.equal((texts.children[3] as any).textStyleId, '', 'the 31/40 text is unique, so it stays unstyled');
  assert.equal(new Set(styled.map((c: any) => c.textStyleId)).size, 1);
});

test('a responsive set imports every size side by side', async () => {
  page.children.length = 0;
  const main = capture();
  main.label = 'Desktop · 1440';
  const tablet = capture();
  tablet.root.w = 200;
  main.breakpoints = [{ label: 'Tablet · 768', width: 768, file: tablet }];
  await importCapture(main, opts, hooks);
  assert.equal(page.children.length, 2, 'two root frames');
  const [a, b] = page.children;
  assert.ok(b.x >= a.x + a.width + 100, 'second size sits to the right with a gap');
  assert.match(a.name, /Desktop · 1440/);
  assert.match(b.name, /Tablet · 768/);
});
