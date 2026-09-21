/**
 * recorder-ipc.ts — renderer-side IPC wrappers for the event recorder
 * (plan 556 Phase 5). Mirrors `workflow-ipc.ts`: every call is a thin
 * `window.electronAPI.recorder.*` pass-through so the components never
 * touch the raw bridge.
 *
 * The three-place contract (AGENTS.md, CodeReviewPanel lesson):
 * `electron/ipc/recorder-handlers.ts` ↔ `electron/preload.ts` ↔ this
 * file + `recorder-types.ts`.
 */

import type {
  LoadedRecorderSession,
  RecorderConvertResult,
  RecorderSessionSummary,
  RecorderStatusSnapshot,
} from './recorder-types';

export interface RecorderApi {
  start: () => Promise<{ ok: boolean; status?: RecorderStatusSnapshot; error?: string }>;
  stop: () => Promise<{ ok: boolean; summary?: RecorderSessionSummary | null; error?: string }>;
  cancel: () => Promise<{ ok: boolean; error?: string }>;
  status: () => Promise<RecorderStatusSnapshot>;
  listSessions: () => Promise<RecorderSessionSummary[]>;
  getSession: (sessionId: string) => Promise<LoadedRecorderSession | null>;
  deleteSession: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  convert: (payload: {
    sessionId: string;
    name?: string;
    description?: string;
  }) => Promise<RecorderConvertResult>;
  onStatusChanged: (callback: (snapshot: RecorderStatusSnapshot) => void) => () => void;
}

function api(): RecorderApi | undefined {
  return (window as unknown as { electronAPI?: { recorder?: RecorderApi } }).electronAPI?.recorder;
}

export async function startRecordingIPC() {
  return api()?.start() ?? { ok: false, error: 'recorder bridge unavailable' };
}

export async function stopRecordingIPC() {
  return api()?.stop() ?? { ok: false, error: 'recorder bridge unavailable' };
}

export async function cancelRecordingIPC() {
  return api()?.cancel() ?? { ok: false, error: 'recorder bridge unavailable' };
}

export async function getRecorderStatusIPC(): Promise<RecorderStatusSnapshot | null> {
  return (await api()?.status()) ?? null;
}

export async function listRecorderSessionsIPC(): Promise<RecorderSessionSummary[]> {
  return (await api()?.listSessions()) ?? [];
}

export async function getRecorderSessionIPC(sessionId: string): Promise<LoadedRecorderSession | null> {
  return (await api()?.getSession(sessionId)) ?? null;
}

export async function deleteRecorderSessionIPC(sessionId: string) {
  return api()?.deleteSession(sessionId) ?? { ok: false, error: 'recorder bridge unavailable' };
}

export async function convertRecorderSessionIPC(payload: {
  sessionId: string;
  name?: string;
  description?: string;
}): Promise<RecorderConvertResult> {
  return (await api()?.convert(payload)) ?? { ok: false, error: 'recorder bridge unavailable' };
}

/** Subscribe to push status updates; returns the unsubscribe function. */
export function onRecorderStatusChangedIPC(
  callback: (snapshot: RecorderStatusSnapshot) => void,
): () => void {
  const bridge = api();
  if (!bridge || typeof bridge.onStatusChanged !== 'function') {
    return () => {};
  }
  return bridge.onStatusChanged(callback);
}

/** `12345` → `00:12` — the badge and the list share one format. */
export function formatRecorderDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Wall-clock time of an event, `HH:MM:SS`. */
export function formatRecorderClock(ts: number): string {
  const date = new Date(ts);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}
