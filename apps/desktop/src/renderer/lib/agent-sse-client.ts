/**
 * One-shot helpers for the Agent Server HTTP API.
 *
 * The chat STREAMING path lives in `agent-http-client.ts`
 * (`AgentServerClient`), which owns the event dedup rules — replayed events
 * are keyed on `(type, data.id)`, while streaming `tool_use_delta` fragments
 * are keyed on the monotonic SSE frame id because the producer reuses one
 * `data.id` for every token of a tool call. This module kept a second copy of
 * that client with weaker rules and no callers, so only the non-streaming
 * endpoints remain here: interrupt, side question, context compaction and
 * permission resolution.
 *
 * Manual SSE parsing (not EventSource) is used where a stream is
 * unavoidable, because those calls are POSTs.
 */

import { applyWorkerUsageSnapshot, type WorkerUsageSnapshot } from '@/stores/context-usage-store';

const SSE_LINE_REGEX = /^(event|id|data):\s*(.*)$/;

// ============================================================================
// API CLIENT FUNCTIONS
// ============================================================================

// Module-private port cache for the non-streaming helpers below. Unlike
// `AgentServerClient.getBaseUrl(forceRefresh)`, this never invalidates: an
// Agent Server that restarts on a different port leaves these four helpers
// calling the stale port until the renderer reloads. Kept as-is because
// changing it would alter live request behaviour.
let cachedPort: number | null = null;

async function getPort(): Promise<number> {
  if (cachedPort !== null) return cachedPort;

  const api = window.electronAPI;
  if (!api?.getAgentServerPort) {
    throw new Error('Agent server port API not available');
  }

  const port = await api.getAgentServerPort();
  if (port === null) {
    throw new Error('Agent server not running');
  }

  cachedPort = port;
  return port;
}

/**
 * Interrupt the current chat generation
 */
export async function interruptChat(sessionId: string): Promise<void> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/chat`;

  const response = await fetch(url, { method: 'DELETE' });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to interrupt chat: ${response.status} ${errorBody}`);
  }
}

export interface SideQuestionResult {
  id: string;
  answer: string;
}

/**
 * Ask a one-shot side question (`/btw`) against a session. The agent server
 * snapshots the current conversation, issues a no-tool single LLM call, and
 * returns a JSON `{ id, answer }` payload. This never mutates the durable
 * transcript.
 */
export async function askSideQuestion(
  sessionId: string,
  question: string,
): Promise<SideQuestionResult> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/btw`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Side question failed: ${response.status} ${errorBody}`);
  }

  const data = (await response.json()) as SideQuestionResult;
  return data;
}

export interface CompactResult {
  success: boolean;
  /** Compaction strategy that ran; 'none' when compaction was a no-op. */
  strategy?: string;
  removedCount?: number;
  remainingCount?: number;
  tokenReduction?: number;
}

export interface CompactCallbacks {
  onDone?: (result: CompactResult) => void;
  onError?: (error: string) => void;
}

/**
 * Compact (compress) context for a session
 */
export async function compactContext(
  sessionId: string,
  callbacks?: CompactCallbacks
): Promise<void> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/compact`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    // Route HTTP failures through callbacks.onError so ChatView's
    // "Compression failed: …" toast renders. Throwing here would leak
    // as an unhandled promise rejection in the main process (terminal
    // 815-817 incident).
    const statusLine = response.statusText ? ` ${response.statusText}` : '';
    const errorMsg = `HTTP ${response.status}${statusLine}${errorBody ? ` — ${errorBody}` : ''}`;
    callbacks?.onError?.(errorMsg);
    return;
  }

  if (!response.body) {
    throw new Error('No response body for compact request');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let eventData = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        // Empty line = SSE event boundary, dispatch accumulated fields
        if (line === '') {
          if (eventType && eventData) {
            if (eventType === 'token_usage') {
              // Post-compaction snapshot pushed by the worker right before
              // compact:done — the only usage events this stream carries.
              // Feed the live store so the ring drops to the compacted size
              // immediately instead of holding the pre-compaction value.
              try {
                const parsed = JSON.parse(eventData) as { data?: Record<string, unknown> };
                applyWorkerUsageSnapshot(sessionId, parsed.data as WorkerUsageSnapshot | undefined);
              } catch {
                // Malformed frame: ignore and let compact:done handling proceed.
              }
            }
            if (eventType === 'compact:done') {
              const parsed = JSON.parse(eventData) as {
                result?: { strategy?: string; tokensRemoved?: number; tokensRetained?: number; removedCount?: number };
              };
              callbacks?.onDone?.({
                success: true,
                // Strategy distinguishes a genuine no-op ('none') from a run
                // that removed nothing — the toast copy depends on it.
                strategy: parsed.result?.strategy,
                removedCount: parsed.result?.removedCount,
                tokenReduction: parsed.result?.tokensRemoved,
              });
              return;
            }
            if (eventType === 'compact:error') {
              const parsed = JSON.parse(eventData) as { message?: string };
              callbacks?.onError?.(parsed.message || 'Unknown error');
              return;
            }
          }
          eventType = '';
          eventData = '';
          continue;
        }

        const match = line.match(SSE_LINE_REGEX);
        if (!match) continue;
        const [, field, val] = match;
        if (field === 'event') eventType = val;
        else if (field === 'data') eventData += (eventData ? '\n' : '') + val;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Resolve a pending permission request
 */
export async function resolvePermission(
  sessionId: string,
  permissionId: string,
  decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session',
  extra?: {
    updatedInput?: Record<string, unknown>;
    message?: string;
  }
): Promise<void> {
  const port = await getPort();
  const url = `http://127.0.0.1:${port}/sessions/${sessionId}/permission`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: permissionId, decision, ...extra }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to resolve permission: ${response.status} ${errorBody}`);
  }
}
