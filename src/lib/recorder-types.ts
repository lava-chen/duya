/**
 * recorder-types.ts — renderer-side view models for the event recorder
 * (plan 556 Phase 5).
 *
 * Declared structurally on purpose: the renderer never imports
 * `@duya/computer-use` (main-process package, native deps), so the
 * shapes here mirror `recorder/events.ts` and `session-store.ts` for
 * the fields the UI actually renders. Keep in sync with
 * `electron/ipc/recorder-handlers.ts`.
 */

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RecorderStatusSnapshot {
  status: RecorderStatus;
  sessionId: string | null;
  startedAt: number | null;
  durationMs: number | null;
  eventCount: number;
  /** True when the input hook died through its restart budget. */
  degraded: boolean;
}

export interface RecorderAppSummary {
  processName: string;
  name: string;
  hits: number;
}

export interface RecorderSessionSummary {
  sessionId: string;
  startedAt: number;
  /** Absent while the session is still open (or after a crash). */
  endedAt?: number;
  eventCount: number;
  apps: RecorderAppSummary[];
}

export interface RecorderBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecorderElement {
  name?: string;
  controlType?: string;
  automationId?: string;
  className?: string;
  rect?: RecorderBbox;
  isPassword?: boolean;
  source: 'uia-probe' | 'none';
}

export interface RecorderAppRef {
  name: string;
  title: string;
  processName: string;
  pid: number;
}

interface EventBase {
  ts: number;
  app: RecorderAppRef;
}

export type RecorderEventView =
  | ({ type: 'app_focus'; browserUrl?: string } & EventBase)
  | ({ type: 'window_open' | 'window_close' } & EventBase)
  | ({
      type: 'click';
      browserUrl?: string;
      click: { x: number; y: number; button: 'left' | 'right' | 'middle'; count: 1 | 2 };
      element: RecorderElement;
    } & EventBase)
  | ({ type: 'type'; browserUrl?: string; text: string; element: RecorderElement } & EventBase)
  | ({ type: 'key'; key: string; modifiers: string[] } & EventBase)
  | ({ type: 'scroll'; direction: 'up' | 'down'; amount: number } & EventBase);

export interface RecorderDroppedLine {
  line: number;
  reason: string;
  preview: string;
}

export interface LoadedRecorderSession {
  summary: RecorderSessionSummary;
  events: RecorderEventView[];
  /** Lines the reader discarded (crash-truncated / schema drift). */
  dropped: RecorderDroppedLine[];
}

export interface RecorderConvertError {
  path: string;
  message: string;
}

export interface RecorderConvertResult {
  ok: boolean;
  /** Present even when `ok` is false so the UI can preview/hand-edit. */
  def?: unknown;
  /** YAML text — the reviewable artifact before saving. */
  yaml?: string;
  errors?: RecorderConvertError[];
  warnings?: string[];
  eventCount?: number;
  droppedLines?: number;
  error?: string;
}

/** Event kinds that represent a user interaction (vs. context). */
export const RECORDER_INTERACTION_TYPES = ['click', 'type', 'key', 'scroll'] as const;
