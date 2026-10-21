/**
 * cua/types.ts — CUA (computer use agent) tool-surface contract.
 *
 * Plan 575: aligns duya's Windows system-level computer-use backend with
 * the ZCode/Codex CUA contract (reverse-engineered 2026-09-28). The 14
 * tool names, the observation receipt, the element payload and the error
 * taxonomy mirror that surface one-for-one; the implementations behind
 * them are duya's own (UIA probe pipeline + Electron primitives).
 *
 * This module is pure data — no electron, no node:child_process — so the
 * contract is unit-testable and shared by the electron service, the
 * agent-side tool schema and the tests.
 */

/** The 14-tool surface, aligned with ZCode `computer.*` (plan 575 §1). */
export const CUA_TOOLS = [
  'list_apps',
  'list_windows',
  'get_app_state',
  'left_click',
  'left_click_drag',
  'scroll',
  'type',
  'set_value',
  'select_text',
  'key',
  'perform_action',
  'paste',
  'request_access',
  'stop_computer_control',
] as const;

export type CuaTool = (typeof CUA_TOOLS)[number];

/** Tools that change UI state — success is void, failure carries action_sent. */
export const CUA_MUTATING_TOOLS: readonly CuaTool[] = [
  'left_click',
  'left_click_drag',
  'scroll',
  'type',
  'set_value',
  'select_text',
  'key',
  'perform_action',
  'paste',
  'stop_computer_control',
];

/** How an action target addresses the UI (aligned: element index or raster pixel). */
export type CuaTarget =
  | { type: 'element'; index: number }
  | { type: 'coordinate'; x: number; y: number; frameId?: string };

/** One observed interactive element (aligned with ZCode element payload). */
export interface CuaElement {
  /** Opaque handle issued by the token ledger (plan 575 §2). */
  native: string;
  /** UIA ControlType as reported by the probe ("Button", "Edit", ...). */
  role: string;
  /** Normalized kind (kindMap — CONTROL_TYPE_TO_KIND alignment). */
  kind: string;
  title: string | null;
  value: string | null;
  /** Screen physical pixels [x, y, w, h]. */
  bounds: [number, number, number, number];
  enabled: boolean;
  focused: boolean;
  editable: boolean;
  /** Semantic actions the element advertises (AX* vocabulary). */
  actions: string[];
  pressable: boolean;
  hasMenu: boolean;
  /** SelectionItemPattern state (probe emits it only when the pattern exists). */
  selected?: boolean;
  /** TogglePattern state (probe emits it only when the pattern exists, plan 576). */
  checked?: boolean;
  /** Non-empty HelpText only (plan 576). */
  description?: string;
  /**
   * REAL UIA tree depth relative to the window root (plan 576 walk
   * contract). Drives the renderer's hierarchy indent and the
   * depth-based ancestor keeping when trimming.
   */
  depth?: number;
  /**
   * Static-Text run absorbed from the neighborhood (plan 576) — the text
   * beside an otherwise-unlabeled field. Absent when no Text neighbor.
   */
  label?: string;
  /** Only when true — the element was reported offscreen by UIA. */
  offscreen?: boolean;
  ownerPid: number | null;
  /** 1-based enumerate order for the owning hwnd (probe cache slot). */
  probeIndex: number;
  /** Owning top-level window handle. */
  hwnd: number;
}

/** Running application info (aligned with ZCode list_apps rows). */
export interface CuaAppInfo {
  pid: number;
  /** Windows has no bundle id — the exe path fills the slot. */
  bundleId: string | null;
  name: string | null;
  active: boolean;
  /** Window title of the process main window, when it has one. */
  title: string | null;
}

/** Top-level window info (aligned with ZCode list_windows rows). */
export interface CuaWindowInfo {
  windowId: number;
  pid: number;
  title: string | null;
  bounds: [number, number, number, number] | null;
  minimized: boolean;
  cloaked: boolean;
}

/**
 * Observation receipt for get_app_state (aligned with ZCode structured
 * content): identity + diff mode + the element table. The text rendering
 * lives in format.ts and is delivered alongside this receipt.
 */
export interface CuaObservation {
  stateId: string;
  snapshotMode: 'full' | 'delta' | 'no_change';
  app: { pid: number; bundleId: string | null; name: string | null };
  window: {
    windowId: number;
    title: string | null;
    bounds: [number, number, number, number] | null;
    /**
     * True when the observation was read from a minimized window (plan
     * 578): the tree is valid but element bounds may sit at the iconic
     * position — restore via a screenshot-bearing observation before
     * coordinate work.
     */
    minimized?: boolean;
  };
  elements: CuaElement[];
  /**
   * True when the probe's walk hit its node/time budget — the element
   * table is a PREFIX of the real tree, never assumed complete
   * (plan 575 gap fix: the model must know the tree was cut short).
   */
  truncated?: boolean;
  /** Delta observations carry the change summary (diff.ts). */
  changes?: CuaSnapshotDiff | undefined;
}

/** Material field change between two snapshots (aligned field set). */
export interface CuaElementChange {
  index: number;
  role: string;
  title: string | null;
  changes: {
    value?: string;
    label?: string | null;
    focused?: boolean;
    enabled?: boolean;
    editable?: boolean;
    checked?: boolean;
    bounds?: [number, number, number, number];
    actions?: string[];
  };
}

export interface CuaSnapshotDiff {
  added: Array<{ index: number; role: string; title: string | null }>;
  updated: CuaElementChange[];
  removed: Array<{ role: string; title: string | null }>;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  focusChanged: boolean;
  focusedTitle: string | null;
}

/**
 * Error taxonomy aligned with ZCode broker codes (plan 575 §2).
 * Values are the wire-stable upper-snake strings.
 */
export const CUA_ERROR_CODES = [
  'PERMISSION_DENIED',
  'NOT_AUTHORIZED',
  'LAUNCH_FAILED',
  'INVALID_APP',
  'ELEMENT_UNAVAILABLE',
  'NOT_SETTABLE',
  'NOT_SELECTABLE',
  'ACTION_UNAVAILABLE',
  'FOREGROUND_REQUIRED',
  'CONTROLLER_BUSY',
  'STALE_STATE',
  'STRUCTURED_STATE_UNAVAILABLE',
  'TIMEOUT',
  'INTERNAL',
] as const;

export type CuaErrorCode = (typeof CUA_ERROR_CODES)[number];

/** Retry semantics (aligned: reobserve / retry / never). */
export type CuaRetry = 'reobserve' | 'retry' | 'never';

const REOBSERVE_CODES: ReadonlySet<CuaErrorCode> = new Set([
  'ELEMENT_UNAVAILABLE',
  'STALE_STATE',
  'STRUCTURED_STATE_UNAVAILABLE',
]);

const NEVER_RETRY_CODES: ReadonlySet<CuaErrorCode> = new Set([
  'CONTROLLER_BUSY',
  'PERMISSION_DENIED',
  'NOT_AUTHORIZED',
  'ACTION_UNAVAILABLE',
  'NOT_SETTABLE',
  'NOT_SELECTABLE',
]);

/**
 * Structured CUA failure. `actionSent` is conservative by design: only
 * true when the dispatch receipt explicitly says the action may have
 * reached the app (possibly_sent) — flipping the default would make the
 * model abandon retries for actions that never landed.
 */
export class CuaError extends Error {
  readonly code: CuaErrorCode;
  readonly actionSent: boolean;
  readonly retry: CuaRetry;

  constructor(
    message: string,
    options: { code?: CuaErrorCode; actionSent?: boolean } = {},
  ) {
    super(message);
    this.name = 'CuaError';
    this.code = options.code ?? 'INTERNAL';
    this.actionSent = options.actionSent === true;
    this.retry = this.actionSent
      ? 'reobserve'
      : NEVER_RETRY_CODES.has(this.code)
        ? 'never'
        : REOBSERVE_CODES.has(this.code)
          ? 'reobserve'
          : 'retry';
  }
}

/** Action dispatch receipt (aligned: accepted / possibly_sent + verification). */
export interface CuaActionReceipt {
  tool: CuaTool;
  actionSent: boolean;
  dispatchStatus: 'accepted' | 'possibly_sent';
  /**
   * Element-path actions re-read the target after dispatch and report
   * whether the post-action state matches the expectation. Coordinate
   * paths leave this undefined (no cheap read-back exists).
   */
  targetVerificationStatus?: 'matched' | 'mismatched' | 'unavailable';
  /** Post-action read-back of the element, when the path can produce one. */
  element?: {
    title: string | null;
    value: string | null;
    controlType: string | null;
  } | null;
}
