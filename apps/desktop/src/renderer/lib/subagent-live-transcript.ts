// src/lib/subagent-live-transcript.ts
// Pure projection of one sub-agent's `chat:agent_progress` event log into
// (a) a renderable transcript and (b) the runtime counters the sidebar panel
// header shows.
//
// WHY THIS EXISTS (plan 571 Phase 2)
// Before it, the sidebar sub-agent panel polled the database every 2.5s with
// `isStreaming={false}`. Everything needed for a real-time view already
// arrives on the parent's SSE channel, keyed by the CHILD session id
// (`AgentProgressEvent.sessionId`, remapped from the wire `agentSessionId`),
// so the panel is a projection problem, not a transport problem.
//
// THE ONE FACT THAT BREAKS EVERY NAIVE IMPLEMENTATION
// `text` and `thinking` events are INCREMENTAL DELTAS, not cumulative
// snapshots — `DuyaAgent.ts` rebuilds the assistant block with
// `assistantContent.push({ text: prefix + event.data })` and
// `lastBlock.text += event.data`. Concatenate them to recover the block.
//
// Everything here is pure and side-effect free so the projection can be unit
// tested without React, without the stream manager and without a store.

import type { Message } from '@/types';
import { deriveSubagentStatus, type SubagentRunStatus } from './subagent-status';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

/**
 * Structural subset of `AgentProgressEvent` (stream-session-manager) that this
 * module consumes. Declared structurally so the projector stays importable
 * from a plain unit test with no store/stream wiring.
 */
export interface SubagentProgressEventLike {
  type: string;
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  receivedAt?: number;
  /** Task id (BackgroundAgentLifecycle record key). */
  agentId?: string;
  /** The sub-agent's own session id. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Tool categories — the single copy of the name sets
// ---------------------------------------------------------------------------

export const SUBAGENT_READ_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'readfile',
  'read_file',
  'read_multiple_files',
]);

export const SUBAGENT_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'edit_file',
  'str_replace_editor',
  'write',
  'writefile',
  'write_file',
  'create_file',
  'createfile',
]);

export const SUBAGENT_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'glob',
  'grep',
  'find_files',
  'search_files',
]);

export const SUBAGENT_SHELL_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'bash',
  'execute',
  'run',
  'execute_command',
  'run_command',
  'powershell',
]);

export type SubagentToolCategory = 'read' | 'edit' | 'search' | 'shell' | 'browser' | 'other';

export interface SubagentToolUseCounts {
  read: number;
  edit: number;
  search: number;
  shell: number;
  browser: number;
  other: number;
  /** Every counted call, i.e. the sum of the categories above. */
  total: number;
}

export function emptySubagentToolUseCounts(): SubagentToolUseCounts {
  return { read: 0, edit: 0, search: 0, shell: 0, browser: 0, other: 0, total: 0 };
}

/** Bucket one tool name. Shared by the row stats and the panel header. */
export function classifySubagentTool(toolName: string | undefined): SubagentToolCategory {
  const name = (toolName ?? '').toLowerCase();
  if (!name) return 'other';
  if (SUBAGENT_READ_TOOLS.has(name)) return 'read';
  if (SUBAGENT_EDIT_TOOLS.has(name)) return 'edit';
  if (SUBAGENT_SEARCH_TOOLS.has(name)) return 'search';
  if (SUBAGENT_SHELL_TOOLS.has(name)) return 'shell';
  if (name.startsWith('browser_') || name.startsWith('browser-') || name === 'browser') return 'browser';
  return 'other';
}

/**
 * Tool-use counts by category.
 *
 * Counts INVOCATIONS (`tool_use`), not completions: while a sub-agent is
 * running the panel header must show the tool it is doing right now, and a
 * result-only count hides every in-flight call. A `tool_result` that could not
 * be paired to any `tool_use` (a legacy session recorded before the buffer
 * existed, or a result whose `tool_use` was lost) is counted too, so real work
 * is never silently missing from the totals.
 */
export function computeSubagentToolUseCounts(
  events: readonly SubagentProgressEventLike[],
): SubagentToolUseCounts {
  const counts = emptySubagentToolUseCounts();
  const callIndexByResult = pairToolCalls(events);

  events.forEach((event, index) => {
    if (event.type === 'tool_use') {
      counts[classifySubagentTool(event.toolName)] += 1;
      counts.total += 1;
      return;
    }
    if (event.type === 'tool_result' && !callIndexByResult.has(index)) {
      counts[classifySubagentTool(event.toolName)] += 1;
      counts.total += 1;
    }
  });
  return counts;
}

// ---------------------------------------------------------------------------
// tool_use <-> tool_result pairing
// ---------------------------------------------------------------------------

/**
 * The wire events carry NO id linking a `tool_result` back to its `tool_use`
 * (`subagentLifecycleBridge.buildChatAgentProgressPayload` only forwards the
 * tool *name*), so the projector pairs them itself:
 *
 *  1. FIFO among pending `tool_use` entries with the same `toolName` — the
 *     agent runs same-named calls in order, so this is exact in practice.
 *  2. Oldest pending entry of any name when the names disagree (a provider
 *     that renames, or a result whose `tool_use` never arrived).
 *  3. No pending entry at all → the result stays unpaired and is rendered
 *     standalone. It is NEVER dropped: losing a tool result hides real work.
 *
 * @returns result event index → index of the `tool_use` event it belongs to.
 */
function pairToolCalls(events: readonly SubagentProgressEventLike[]): Map<number, number> {
  const pendingByName = new Map<string, number[]>();
  const pendingAll: number[] = [];
  const callNameByEvent = new Map<number, string>();
  const callIndexByResult = new Map<number, number>();

  events.forEach((event, index) => {
    if (event.type === 'tool_use') {
      const name = (event.toolName ?? '').toLowerCase();
      const queue = pendingByName.get(name);
      if (queue) queue.push(index);
      else pendingByName.set(name, [index]);
      pendingAll.push(index);
      callNameByEvent.set(index, name);
      return;
    }
    if (event.type !== 'tool_result') return;

    const name = (event.toolName ?? '').toLowerCase();
    let callIndex = pendingByName.get(name)?.shift();
    if (callIndex === undefined && name) {
      // Name mismatch: fall back to the oldest pending entry overall.
      callIndex = pendingAll.shift();
      if (callIndex !== undefined) {
        removeFromQueue(pendingByName, callNameByEvent.get(callIndex) ?? '', callIndex);
      }
    } else if (callIndex !== undefined) {
      const at = pendingAll.indexOf(callIndex);
      if (at >= 0) pendingAll.splice(at, 1);
    }
    if (callIndex !== undefined) callIndexByResult.set(index, callIndex);
  });

  return callIndexByResult;
}

function removeFromQueue(
  pendingByName: Map<string, number[]>,
  name: string,
  value: number,
): void {
  const queue = pendingByName.get(name);
  if (!queue) return;
  const at = queue.indexOf(value);
  if (at >= 0) queue.splice(at, 1);
  if (queue.length === 0) pendingByName.delete(name);
}

// ---------------------------------------------------------------------------
// Transcript projection
// ---------------------------------------------------------------------------

export interface SubagentLiveTranscript {
  /** Renderable transcript for `MessageList`. */
  messages: Message[];
  status: SubagentRunStatus;
  toolCounts: SubagentToolUseCounts;
  /** Wall-clock of the first event, or null for an empty log. */
  startedAt: number | null;
  /** Wall-clock of the terminal event, or null while still running. */
  terminalAt: number | null;
  /**
   * Wall-clock of the most recent event of ANY type, including `heartbeat`.
   * Heartbeats are keepalives, not content, so they never enter `messages` —
   * but they are the strongest liveness signal the child emits.
   */
  lastActivityAt: number | null;
  /** Text of the terminal `error` (or killed `done`/`error`) event. */
  terminalText: string | null;
}

type LiveNode =
  | { kind: 'text'; at: number; text: string }
  | { kind: 'thinking'; at: number; text: string }
  | {
      kind: 'tool';
      at: number;
      callSeq: number;
      toolName: string;
      toolInput?: Record<string, unknown>;
      durationMs?: number;
      /** False for a `tool_result` that arrived with no pending `tool_use`. */
      hasCall: boolean;
      resultText?: string;
      resultAt?: number;
      resultIsError?: boolean;
    };

const TOOL_ERROR_MARKER = '<tool_error>';

function toolResultText(event: SubagentProgressEventLike): string {
  if (typeof event.toolResult === 'string' && event.toolResult) return event.toolResult;
  if (typeof event.data === 'string' && event.data) return event.data;
  return '';
}

/**
 * Project the ordered event log of one sub-agent run into a transcript.
 *
 * Boundaries mirror how the real agent builds its own transcript
 * (`DuyaAgent.ts`): a text delta appends to the open text block, and a
 * `tool_use` (or a switch to thinking) closes it. The leading `'\n'` a new
 * text block receives after a tool boundary is reproduced verbatim so the live
 * view and the persisted DB row render identical markdown.
 *
 * `started` / `heartbeat` / `hook_invoked` / `done` / `error` are lifecycle
 * signals, not transcript content: they advance the status and the activity
 * clock and never become rows. `hook_invoked` is excluded for the same reason
 * the agent renders it out of band — it duplicates work the tool row already
 * reports.
 */
export function projectSubagentLiveTranscript(
  events: readonly SubagentProgressEventLike[],
): SubagentLiveTranscript {
  const nodes: LiveNode[] = [];
  const nodeIndexByEvent = new Map<number, number>();
  // Mirrors `assistantContent.length` in DuyaAgent: only text and tool_use
  // blocks count there, thinking accumulates separately.
  let contentBlockCount = 0;
  let callSeq = 0;
  let startedAt: number | null = null;
  let terminalAt: number | null = null;
  let terminalText: string | null = null;
  let lastActivityAt: number | null = null;
  let firstEventAt: number | null = null;
  const callIndexByResult = pairToolCalls(events);

  events.forEach((event, index) => {
    const at = typeof event.receivedAt === 'number' ? event.receivedAt : lastActivityAt ?? 0;
    if (typeof event.receivedAt === 'number') {
      lastActivityAt = event.receivedAt;
      if (firstEventAt === null) firstEventAt = event.receivedAt;
    }

    if (event.type === 'started') {
      if (startedAt === null) startedAt = at;
      return;
    }
    if (event.type === 'heartbeat' || event.type === 'hook_invoked') return;

    if (event.type === 'done' || event.type === 'error') {
      terminalAt = at;
      if (typeof event.data === 'string' && event.data.trim()) terminalText = event.data.trim();
      return;
    }

    if (event.type === 'text') {
      const delta = typeof event.data === 'string' ? event.data : '';
      if (!delta) return;
      const last = nodes[nodes.length - 1];
      if (last && last.kind === 'text') {
        last.text += delta;
        return;
      }
      nodes.push({
        kind: 'text',
        at,
        text: contentBlockCount > 0 ? `\n${delta}` : delta,
      });
      contentBlockCount += 1;
      return;
    }

    if (event.type === 'thinking') {
      const delta = typeof event.data === 'string' ? event.data : '';
      if (!delta) return;
      const last = nodes[nodes.length - 1];
      if (last && last.kind === 'thinking') {
        last.text += delta;
        return;
      }
      nodes.push({ kind: 'thinking', at, text: delta });
      return;
    }

    if (event.type === 'tool_use') {
      callSeq += 1;
      const node: LiveNode = {
        kind: 'tool',
        at,
        callSeq,
        toolName: event.toolName ?? 'tool',
        hasCall: true,
      };
      if (event.toolInput) node.toolInput = event.toolInput;
      if (typeof event.duration === 'number') node.durationMs = event.duration;
      nodes.push(node);
      contentBlockCount += 1;
      nodeIndexByEvent.set(index, nodes.length - 1);
      return;
    }

    if (event.type === 'tool_result') {
      const callIndex = callIndexByResult.get(index);
      const callNodeIndex = callIndex === undefined ? undefined : nodeIndexByEvent.get(callIndex);
      const callNode = callNodeIndex === undefined ? undefined : nodes[callNodeIndex];
      if (callNode && callNode.kind === 'tool') {
        callNode.resultText = toolResultText(event);
        callNode.resultAt = at;
        callNode.resultIsError = callNode.resultText.includes(TOOL_ERROR_MARKER);
        if (typeof event.duration === 'number') callNode.durationMs = event.duration;
        return;
      }
      // Unpaired result: render it standalone rather than dropping it.
      callSeq += 1;
      const orphan: LiveNode = {
        kind: 'tool',
        at,
        callSeq,
        toolName: event.toolName ?? 'tool',
        hasCall: false,
      };
      if (event.toolInput) orphan.toolInput = event.toolInput;
      if (typeof event.duration === 'number') orphan.durationMs = event.duration;
      orphan.resultText = toolResultText(event);
      orphan.resultAt = at;
      orphan.resultIsError = orphan.resultText.includes(TOOL_ERROR_MARKER);
      nodes.push(orphan);
      contentBlockCount += 1;
    }
  });

  const status = deriveSubagentStatus(events);
  if (startedAt === null) startedAt = firstEventAt;

  return {
    messages: nodesToMessages(nodes),
    status,
    toolCounts: computeSubagentToolUseCounts(events),
    startedAt,
    terminalAt,
    lastActivityAt,
    terminalText,
  };
}

function nodesToMessages(nodes: readonly LiveNode[]): Message[] {
  const messages: Message[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      messages.push({
        id: `subagent-live-text-${messages.length}`,
        role: 'assistant',
        content: node.text,
        msgType: 'text',
        timestamp: node.at,
        status: 'done',
      });
      continue;
    }
    if (node.kind === 'thinking') {
      messages.push({
        id: `subagent-live-thinking-${messages.length}`,
        role: 'assistant',
        content: '',
        msgType: 'thinking',
        thinking: node.text,
        timestamp: node.at,
        status: 'done',
      });
      continue;
    }

    const callId = `subagent-live-call-${node.callSeq}`;
    if (node.hasCall) {
      messages.push({
        id: `${callId}-use`,
        role: 'assistant',
        content: '',
        msgType: 'tool_use',
        tool_call_id: callId,
        toolName: node.toolName,
        // `Message.toolInput` is a JSON string in the renderer DTO (see
        // `parseToolInputSafe`), so serialize rather than pass the object.
        toolInput: JSON.stringify(node.toolInput ?? {}),
        timestamp: node.at,
        durationMs: node.durationMs ?? null,
        status: node.resultText === undefined ? 'running' : node.resultIsError ? 'error' : 'done',
      });
    }
    if (node.resultText !== undefined) {
      messages.push({
        id: `${callId}-result`,
        role: 'tool',
        content: node.resultText,
        msgType: 'tool_result',
        tool_call_id: callId,
        toolName: node.toolName,
        timestamp: node.resultAt ?? node.at,
        durationMs: node.durationMs ?? null,
        status: node.resultIsError ? 'error' : 'done',
      });
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Merging persisted history with the live tail
// ---------------------------------------------------------------------------

export interface SubagentTranscriptMergeInput {
  /** Persisted rows for the sub-agent session (DB projection). */
  history: readonly Message[];
  /** Live projection for the same session; may be empty. */
  live: readonly Message[];
  /**
   * Wall-clock of the first live event. Assistant/tool rows at or after this
   * instant are already represented by `live` in full.
   */
  liveStartedAt: number | null;
}

/**
 * Merge persisted history with the live tail WITHOUT duplicating the run.
 *
 * The live projection is a COMPLETE transcript of the run (the buffer replays
 * from the first `started` event), while the DB holds a PREFIX of the same
 * run, persisted at message boundaries. Plain concatenation would render every
 * already-persisted tool call and paragraph twice.
 *
 * Rules, in order:
 *  1. No live tail → the DB is the only source of truth (historical session,
 *     or a renderer restart that lost the event buffer).
 *  2. `role: 'user' | 'system'` rows are always kept. The progress channel
 *     never carries them, so they are the reason the DB is read at all — the
 *     sub-agent's prompt lives only there.
 *  3. Assistant/tool rows stamped at or after `liveStartedAt` are dropped: the
 *     live tail already contains that run end to end.
 *  4. Anything older is genuine earlier history and is kept ahead of the tail.
 */
export function mergeSubagentTranscriptHistory(input: SubagentTranscriptMergeInput): Message[] {
  const { history, live, liveStartedAt } = input;
  if (live.length === 0) return [...history];

  const kept = history.filter((message) => {
    if (message.role === 'user' || message.role === 'system') return true;
    if (liveStartedAt === null) return true;
    return message.timestamp < liveStartedAt;
  });

  return [...kept, ...live];
}
