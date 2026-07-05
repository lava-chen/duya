/**
 * Single source of truth for sticky-note color palette.
 *
 * Colors map to the Diagram module's semantic classes (see
 * `packages/agent/src/tool/ModuleTool/inline-content.ts` for the full spec).
 * The fill+stroke hex values are sourced directly from the diagram palette
 * defined in `packages/conductor/src/renderer/elements/widget-sanitizer.ts`
 * so a sticky note and a `.s-*` rectangle share the exact same color.
 *
 * Mapping:
 *   yellow → .s-chk  (Amber - check / decision)
 *   blue   → .s-proc (Blue  - process)
 *   green  → .s-agent (Green - agent / success)
 *   pink   → .s-err  (Red   - error, name kept for back-compat)
 *   purple → .s-msg  (Purple - message / IPC)
 *   gray   → .s-sub  (Gray  - neutral)
 */
export type StickyColorKey =
  | "yellow"
  | "blue"
  | "green"
  | "pink"
  | "purple"
  | "gray";

export const STICKY_COLOR_KEYS: readonly StickyColorKey[] = [
  "yellow",
  "blue",
  "green",
  "pink",
  "purple",
  "gray",
];

export const STICKY_COLOR_SET: ReadonlySet<StickyColorKey> = new Set(
  STICKY_COLOR_KEYS,
);

export interface StickyColorTheme {
  /** Fill color — matches the corresponding diagram .s-* fill. */
  bg: string;
  /** Foreground text color — kept from legacy Palette A for contrast on the new fill. */
  text: string;
  /** Placeholder ("Add text") color — low-contrast variant of `text`. */
  placeholder: string;
  /** Default border color — matches the corresponding diagram .s-* stroke. */
  stroke: string;
}

export const STICKY_COLORS: Record<StickyColorKey, StickyColorTheme> = {
  yellow: {
    bg: "rgb(250,238,218)",
    text: "#5C4A00",
    placeholder: "rgba(92,74,0,0.3)",
    stroke: "rgb(133,79,11)",
  },
  blue: {
    bg: "rgb(230,241,251)",
    text: "#0D3A66",
    placeholder: "rgba(13,58,102,0.3)",
    stroke: "rgb(24,95,165)",
  },
  green: {
    bg: "rgb(225,245,238)",
    text: "#1A4D1A",
    placeholder: "rgba(26,77,26,0.3)",
    stroke: "rgb(15,110,86)",
  },
  pink: {
    bg: "rgb(252,235,235)",
    text: "#661A3D",
    placeholder: "rgba(102,26,61,0.3)",
    stroke: "rgb(163,45,45)",
  },
  purple: {
    bg: "rgb(238,237,254)",
    text: "#3D1A5C",
    placeholder: "rgba(61,26,92,0.3)",
    stroke: "rgb(83,74,183)",
  },
  gray: {
    bg: "rgb(241,239,232)",
    text: "#333333",
    placeholder: "rgba(51,51,51,0.3)",
    stroke: "rgb(95,94,90)",
  },
};

/** Comma-separated list of keys, suitable for prompt/schema enum descriptions. */
export const STICKY_COLOR_LIST: string = STICKY_COLOR_KEYS.join("|");