import type { RegionMetrics, RegionPatch, SurfaceRegion } from '../types.js';
import type { SceneLine } from '../../core/span.js';

export interface SurfaceSize {
  readonly columns: number;
  readonly rows: number;
}

export interface RegionLayout {
  readonly metrics: RegionMetrics;
  readonly borderStyle: NonNullable<RegionPatch['borderStyle']>;
  readonly borderColor: string;
  readonly hidden: boolean;
  /** Body lines in either representation: tags or spans. */
  readonly lines: readonly SceneLine[];
  /**
   * Columns the content is drawn into, border excluded.
   *
   * Kept beside `metrics.innerWidth` rather than folded into it because the
   * two conventions differ: blessed's `iwidth` is the space the border EATS
   * (`width - iwidth` is the content width), while callers that lay text out
   * want the content width itself. `metrics` speaks blessed's convention so
   * both renderers answer the same question the same way; the painter, which
   * is private to this renderer, uses these.
   */
  readonly contentWidth: number;
  /** Rows the content is drawn into, border excluded. */
  readonly contentHeight: number;
}

export interface GeometryOptions {
  readonly size: SurfaceSize;
  readonly statusRows: number;
  readonly overlayWidth: string;
  readonly unicodeBox?: boolean;
}

const APPEND_ORDER: readonly SurfaceRegion[] = [
  'transcript',
  'input',
  'status',
  'overlay',
  'completion',
];

const DEFAULT_BORDER: Readonly<Record<SurfaceRegion, NonNullable<RegionPatch['borderStyle']>>> = {
  transcript: 'none',
  input: 'composer',
  status: 'none',
  overlay: 'framed',
  completion: 'framed',
};

const DEFAULT_HEIGHT: Readonly<Record<SurfaceRegion, number | undefined>> = {
  transcript: undefined,
  input: 3,
  status: undefined,
  overlay: 7,
  completion: 3,
};

const DEFAULT_BOTTOM: Readonly<Record<SurfaceRegion, number | undefined>> = {
  transcript: undefined,
  input: undefined,
  status: 0,
  overlay: undefined,
  completion: undefined,
};

const DEFAULT_HIDDEN: Readonly<Record<SurfaceRegion, boolean>> = {
  transcript: false,
  input: false,
  status: false,
  overlay: true,
  completion: true,
};

const DEFAULT_BORDER_COLOR: Readonly<Record<SurfaceRegion, string>> = {
  transcript: 'gray',
  input: 'green',
  status: 'gray',
  overlay: 'yellow',
  completion: 'cyan',
};

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function percentage(value: string, fallback: number): number {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return fallback;
  return Math.max(1, Math.min(100, Number(match[1]))) / 100;
}

function boxSize(
  region: SurfaceRegion,
  patch: RegionPatch | undefined,
  options: GeometryOptions,
): { left: number; top: number; width: number; height: number } {
  const columns = positiveInt(options.size.columns, 80);
  const rows = positiveInt(options.size.rows, 24);
  const height = Math.max(1, Math.floor(patch?.height ?? DEFAULT_HEIGHT[region] ?? 1));
  const bottom = Math.max(
    0,
    Math.floor(
      patch?.bottom ??
        DEFAULT_BOTTOM[region] ??
        (region === 'transcript' || region === 'completion' ? 3 + options.statusRows : options.statusRows),
    ),
  );

  switch (region) {
    case 'transcript': {
      const transcriptHeight =
        patch?.height === undefined ? Math.max(1, rows - bottom) : height;
      return { left: 0, top: 0, width: columns, height: transcriptHeight };
    }
    case 'input':
      return {
        left: 0,
        top: rows - height - bottom,
        width: columns,
        height,
      };
    case 'status':
      return {
        left: 0,
        top: rows - height - bottom,
        width: columns,
        height,
      };
    case 'overlay': {
      const width = Math.min(columns, Math.max(1, Math.floor(columns * percentage(options.overlayWidth, 0.7))));
      return {
        left: Math.floor((columns - width) / 2),
        top: Math.round((rows - height) / 2),
        width,
        height,
      };
    }
    case 'completion':
      return {
        left: 4,
        top: rows - height - bottom,
        width: Math.max(1, columns - 8),
        height,
      };
  }
}

function insets(style: NonNullable<RegionPatch['borderStyle']>): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  if (style === 'none') return { left: 0, right: 0, top: 0, bottom: 0 };
  return { left: 1, right: 1, top: 1, bottom: 1 };
}

export function layoutRegion(
  region: SurfaceRegion,
  patch: RegionPatch | undefined,
  options: GeometryOptions,
  laidOut: boolean,
): RegionLayout {
  const box = boxSize(region, patch, options);
  const borderStyle = patch?.borderStyle ?? DEFAULT_BORDER[region];
  const inset = insets(borderStyle);
  return {
    metrics: {
      width: box.width,
      height: box.height,
      left: box.left,
      top: box.top,
      innerLeft: inset.left,
      innerTop: inset.top,
      // blessed's `iwidth`/`iheight`: what the border costs, NOT what is left
      // inside it. Every `RegionMetrics` consumer does `width - innerWidth`
      // (see `TUIApp.composerWidth`), so reporting the content width here made
      // `own` and `blessed` disagree by the border on every framed region.
      innerWidth: inset.left + inset.right,
      innerHeight: inset.top + inset.bottom,
      laidOut,
    },
    borderStyle,
    borderColor: patch?.borderColor ?? DEFAULT_BORDER_COLOR[region],
    hidden: patch?.hidden ?? DEFAULT_HIDDEN[region],
    lines: patch?.lines ?? [],
    contentWidth: Math.max(0, box.width - inset.left - inset.right),
    contentHeight: Math.max(0, box.height - inset.top - inset.bottom),
  };
}

export function screenRegions(): readonly SurfaceRegion[] {
  return APPEND_ORDER;
}
