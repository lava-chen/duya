/**
 * workflow-run-stream.ts — plan 560 D5: the run-anchored event stream client.
 *
 * A library run has no chat session, so nothing else carries its progress: the
 * panel subscribes to `/workflow-runtime/:runId/events` directly. The wire
 * contract is small and is the same for both replay sources:
 *
 *   event: record    {seq, record}      ← the journal cursor is `seq`
 *   event: artifact  {artifact}
 *   event: permission{request}
 *   event: done      {summary}          ← terminal, the server closes here
 *   event: error     {error}            ← run not found / transport problem
 *
 * `afterSeq` is the resume key: on (re)connect the client asks for everything
 * past the last seq it actually applied, so a dropped frame is recovered rather
 * than lost. Deduplication still happens store-side (see `mergeRunEvents`)
 * because a replay can legitimately overlap what the live stream already sent.
 *
 * Parsing follows `agent-sse-client.ts` (manual SSE over fetch — no EventSource,
 * because we need a custom `afterSeq` query and a clean abort), minus its
 * console logging: a run can sit silent for minutes and that would be noise.
 */

import { getWorkflowRunEventsIPC } from '@/lib/workflow-ipc';

const SSE_LINE_REGEX = /^(event|id|data):\s*(.*)$/;

export type WorkflowRunFrameKind = 'record' | 'artifact' | 'permission' | 'done' | 'error';

export interface WorkflowRunSseFrame {
  frame: WorkflowRunFrameKind;
  runId: string;
  seq?: number;
  record?: unknown;
  artifact?: unknown;
  request?: unknown;
  summary?: unknown;
  error?: string;
}

export interface OpenWorkflowRunStreamOptions {
  runId: string;
  /** Journal cursor: replay everything after this seq. */
  afterSeq: number;
  onFrame: (frame: WorkflowRunSseFrame) => void;
  signal: AbortSignal;
  /** Port resolver, injectable for tests. Defaults to the electron bridge. */
  resolvePort?: () => Promise<number | null>;
  /** Fetch, injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type RunStreamEndReason = 'done' | 'aborted' | 'error';

export interface RunStreamResult {
  ended: RunStreamEndReason;
  /** Transport-level detail when `ended === 'error'`. */
  error?: string;
}

async function defaultResolvePort(): Promise<number | null> {
  const api = window.electronAPI;
  if (!api?.getAgentServerPort) return null;
  return api.getAgentServerPort();
}

/**
 * Subscribe to a run's event stream and resolve when it ends.
 *
 * Resolves — never rejects — so the caller's reconnect loop stays linear: the
 * `ended` reason is the only branch that matters.
 */
export async function openWorkflowRunStream(
  options: OpenWorkflowRunStreamOptions,
): Promise<RunStreamResult> {
  const { runId, afterSeq, onFrame, signal } = options;
  const resolvePort = options.resolvePort ?? defaultResolvePort;
  const doFetch = options.fetchImpl ?? fetch;

  const port = await resolvePort();
  if (port === null) {
    return { ended: 'error', error: 'agent server not running' };
  }

  let response: Response;
  try {
    response = await doFetch(
      `http://127.0.0.1:${port}/workflow-runtime/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`,
      { headers: { Accept: 'text/event-stream' }, signal },
    );
  } catch (err) {
    if (signal.aborted) return { ended: 'aborted' };
    return { ended: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok || !response.body) {
    return { ended: 'error', error: `stream open failed (${response.status})` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  // One SSE event = `event:` + optional `id:` + one or more `data:` lines,
  // terminated by a blank line. Frames are single-line JSON, but the parser
  // stays general so a multi-line payload cannot silently corrupt a run view.
  let eventType = '';
  let eventId = '';
  let eventData = '';

  const flush = (): void => {
    if (!eventData) {
      eventType = '';
      eventId = '';
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(eventData);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      // A frame we cannot parse is not a frame: emit nothing rather than an
      // all-undefined one the store would have to defend against. The durable
      // journal still holds the record, so nothing is lost.
      eventType = '';
      eventId = '';
      eventData = '';
      return;
    }
    const body = parsed as Record<string, unknown>;
    const kind = (eventType || (body.frame as string)) as WorkflowRunFrameKind;
    if (kind === 'record' || kind === 'artifact' || kind === 'permission' || kind === 'done' || kind === 'error') {
      onFrame({
        frame: kind,
        runId: (body.runId as string) ?? runId,
        ...(typeof body.seq === 'number' ? { seq: body.seq } : {}),
        record: body.record,
        artifact: body.artifact,
        request: body.request,
        summary: body.summary,
        ...(typeof body.error === 'string' ? { error: body.error } : {}),
      });
      if (kind === 'done') sawDone = true;
    }
    eventType = '';
    eventId = '';
    eventData = '';
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line === '') {
          flush();
          continue;
        }
        const match = line.match(SSE_LINE_REGEX);
        if (!match) continue; // comment / keep-alive line
        const [, field, value] = match;
        if (field === 'event') eventType = value;
        else if (field === 'id') eventId = value;
        else if (field === 'data') eventData += (eventData ? '\n' : '') + value;
      }
      if (sawDone) break;
    }
  } catch (err) {
    if (signal.aborted) return { ended: 'aborted' };
    return { ended: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    reader.releaseLock();
  }

  return { ended: sawDone ? 'done' : 'aborted' };
}

/**
 * Durable backfill: everything the events table holds past `afterSeq`.
 *
 * This is the other half of D5 — a run that finished while the app was closed
 * has no live process to attach to, so the row + journal are the only source.
 */
export async function fetchRunEventBackfill(
  runId: string,
  afterSeq: number,
): Promise<unknown[] | undefined> {
  try {
    return await getWorkflowRunEventsIPC({ runId, afterSeq });
  } catch {
    return undefined;
  }
}
