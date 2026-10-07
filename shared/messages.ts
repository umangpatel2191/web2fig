import type { CaptureFile, CaptureModeName } from './schema';

/* ---------- Extension ---------- */

export type CaptureMode = CaptureModeName;

export type ScrollSpeed = 'balanced' | 'thorough';

export interface CaptureOptions {
  /** Scroll through the page first so lazy-loaded content renders and reveal animations finish. */
  lazy: boolean;
  /** How patiently to scroll: `balanced` for most sites, `thorough` for heavily animated ones. Neither has a time limit. */
  speed: ScrollSpeed;
  /** Embed images into the capture. */
  images: boolean;
  /** Also capture a tablet (768px) and a mobile (390px) layout and import all sizes side by side. */
  responsive: boolean;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = { lazy: true, speed: 'balanced', images: true, responsive: false };

export interface CaptureSummary {
  title: string;
  url: string;
  mode: CaptureMode;
  bytes: number;
  layers: number;
  texts: number;
  images: number;
  svgs: number;
  fonts: number;
  warnings: string[];
  copied: boolean;
  at: number;
}

/* ---------- Figma plugin ---------- */

export interface ImportOptions {
  autoLayout: boolean;
  images: boolean;
  variables: boolean;
  /** Create reusable text styles for typography that repeats. */
  textStyles: boolean;
  /** Import onto a new page instead of the current one. */
  newPage: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  autoLayout: true,
  images: true,
  variables: true,
  textStyles: true,
  newPage: false,
};

export interface ImportResult {
  layers: number;
  autoLayouts: number;
  autoLayoutCandidates: number;
  images: number;
  imagesFailed: number;
  variables: number;
  substitutions: { requested: string; used: string; count: number }[];
  warnings: string[];
  ms: number;
}

export type UiToMain =
  | { type: 'ready' }
  | { type: 'import'; capture: CaptureFile; options: ImportOptions }
  | { type: 'cancel' }
  | { type: 'saveSettings'; options: ImportOptions }
  | { type: 'notify'; text: string };

export type MainToUi =
  | { type: 'settings'; options: ImportOptions }
  | { type: 'progress'; done: number; total: number; stage: string }
  | { type: 'done'; result: ImportResult }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };
