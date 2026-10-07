/**
 * Webframe capture format (v1).
 *
 * The Chrome extension produces a `CaptureFile`; the Figma plugin consumes it.
 * Coordinates are in CSS pixels. Every node's x/y is relative to its parent frame.
 */

export const MAGIC = 'webframe';
export const SCHEMA_VERSION = 1;

export interface RGBA {
  r: number; // 0..1
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  pos: number; // 0..1
  color: RGBA;
}

export type Paint =
  | { type: 'solid'; color: RGBA }
  | { type: 'linear'; angle: number; stops: GradientStop[] } // CSS angle in degrees
  | { type: 'radial'; cx: number; cy: number; rx: number; ry: number; stops: GradientStop[] } // px in node space
  | { type: 'image'; asset: string; fit: 'fill' | 'fit' | 'stretch' | 'tile'; /** tile size in px (fit: tile) */ tile?: { w: number; h: number }; /** object-position / background-position as 0..1 fractions (fill only) */ pos?: [number, number] };

export interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: RGBA;
}

export interface Stroke {
  top: number;
  right: number;
  bottom: number;
  left: number;
  color: RGBA;
  dash?: 'dashed' | 'dotted';
}

/** top-left, top-right, bottom-right, bottom-left */
export type Corners = [number, number, number, number];

export type BlendName =
  | 'MULTIPLY'
  | 'SCREEN'
  | 'OVERLAY'
  | 'DARKEN'
  | 'LIGHTEN'
  | 'COLOR_DODGE'
  | 'COLOR_BURN'
  | 'HARD_LIGHT'
  | 'SOFT_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY';

/** CSS clip-path basic shapes, in the element's own pixel space (origin = top-left of its border box). */
export type ClipShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: Corners }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'poly'; pts: [number, number][]; evenodd?: boolean }
  | { kind: 'path'; d: string; evenodd?: boolean };

interface NodeBase {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  blend?: BlendName;
  /** Out-of-flow (position: absolute | fixed). Kept absolute inside Auto Layout frames. */
  abs?: boolean;
  /** Full local transform [a,b,c,d,tx,ty] in the parent's space (CSS transform / rotate / scale / translate). x/y stay the untransformed layout position. */
  rel?: [number, number, number, number, number, number];
}

export interface FrameNode extends NodeBase {
  type: 'frame';
  fills?: Paint[];
  stroke?: Stroke;
  radius?: Corners;
  shadows?: Shadow[];
  clip?: boolean;
  /** clip-path → rebuilt as a Figma mask layer */
  clipShape?: ClipShape;
  /** mask-image gradient → Figma alpha mask */
  mask?: Paint;
  blur?: number; // CSS px (filter: blur)
  bgBlur?: number; // CSS px (backdrop-filter: blur)
  children: LayerNode[];
}

export interface FontSpec {
  families: string[];
  size: number;
  weight: number;
  italic: boolean;
  /** Line height in px. */
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  decoration: 'none' | 'underline' | 'line-through';
}

export interface TextLayer extends NodeBase {
  type: 'text';
  /** Lines are pre-broken with "\n" so wrapping matches the browser exactly. */
  text: string;
  font: FontSpec;
  color: RGBA;
  /** Gradient fill (background-clip: text) in the text layer's own bounds; replaces `color` when present. */
  paint?: Paint;
  shadows?: Shadow[];
  /** Hyperlink target of the enclosing <a>. */
  href?: string;
  /** -webkit-text-stroke */
  stroke?: { w: number; color: RGBA };
}

export interface SvgLayer extends NodeBase {
  type: 'svg';
  /** Inline SVG markup. */
  svg?: string;
  /** Or a reference into `assets` (kind: svg). */
  asset?: string;
}

export type LayerNode = FrameNode | TextLayer | SvgLayer;

export type Asset =
  | { kind: 'raster'; mime: string; data: string; w: number; h: number } // data = base64
  | { kind: 'svg'; svg: string };

export interface FontUsage {
  family: string;
  weights: number[];
  italic: boolean;
  count: number;
}

export type CaptureModeName = 'full' | 'visible' | 'element';

export interface CaptureFile {
  magic: typeof MAGIC;
  version: number;
  tool: { name: string; version: string };
  source: {
    url: string;
    title: string;
    capturedAt: string;
    mode: CaptureModeName;
    viewport: { w: number; h: number };
    dpr: number;
  };
  /** Small JPEG data URL used for the plugin preview. */
  thumbnail?: string;
  /** Name of this layout when several sizes were captured ("Desktop · 1440"). */
  label?: string;
  /** Additional layouts of the same page (responsive set), imported next to the main one. */
  breakpoints?: { label: string; width: number; file: CaptureFile }[];
  root: FrameNode;
  assets: Record<string, Asset>;
  fonts: FontUsage[];
  stats: { layers: number; texts: number; images: number; svgs: number };
  warnings: string[];
}
