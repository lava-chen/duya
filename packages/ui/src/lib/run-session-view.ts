import type { RunSessionSnapshot } from '@duya/client-core';
import type { Message } from '@/types/message';

/**
 * The time of a live row this projection cannot know.
 *
 * The RunSession surface carries the event SEQUENCE and the payload, not the
 * envelope's wall clock, so a live row has no truthful time of its own yet.
 * The transcript treats a non-finite timestamp as "no time" (the chat views
 * guard their time separators with `Number.isFinite`), which is exactly what
 * this is. It is deliberately not 0: zero is a real instant, and a row dated
 * 1970 is a claim the Host never made.
 */
const UNKNOWN_TIME = Number.NaN;

/** Map the authoritative RunSession projection into the existing transcript row shape. */
export function runSessionMessages(snapshot: RunSessionSnapshot | null): Message[] {
  if (!snapshot) return [];

  const firstSequence = new Map<string, number>();
  const settlementSequence = new Map<string, number>();
  for (const item of snapshot.timeline) {
    const payload = item.payload;
    if (
      payload.type === 'assistant.text_block' ||
      payload.type === 'assistant.text_delta' ||
      payload.type === 'assistant.thinking_block' ||
      payload.type === 'assistant.thinking_delta' ||
      payload.type === 'assistant.message_finalized'
    ) {
      firstSequence.set(`message:${payload.messageId}`, Math.min(
        firstSequence.get(`message:${payload.messageId}`) ?? Number.MAX_SAFE_INTEGER,
        item.seq,
      ));
    } else if (
      payload.type === 'tool.call_preview' ||
      payload.type === 'tool.call_started' ||
      payload.type === 'tool.arguments_delta' ||
      payload.type === 'tool.progress' ||
      payload.type === 'tool.call_completed' ||
      payload.type === 'tool.timed_out'
    ) {
      firstSequence.set(`tool:${payload.toolCallId}`, Math.min(
        firstSequence.get(`tool:${payload.toolCallId}`) ?? Number.MAX_SAFE_INTEGER,
        item.seq,
      ));
      if (payload.type === 'tool.call_completed' || payload.type === 'tool.timed_out') {
        // The result is interleaved at the seq the call actually SETTLED on,
        // not at the seq the call started on: a tool that took ten events to
        // finish has not produced its result at start+1.
        settlementSequence.set(`tool:${payload.toolCallId}`, item.seq);
      }
    }
  }

  const rows: Message[] = [];
  for (const message of snapshot.messages) {
    if (message.text || message.thinking) {
      rows.push({
        id: `run:${snapshot.runId}:${message.messageId}`,
        runId: snapshot.runId,
        role: 'assistant',
        content: message.text,
        thinking: message.thinking || null,
        timestamp: UNKNOWN_TIME,
        seqIndex: firstSequence.get(`message:${message.messageId}`) ?? null,
        sequenceDomain: 'run-event',
        ...(message.text ? {} : { msgType: 'thinking' as const }),
        status: message.finalized ? 'done' : 'streaming',
      });
    }
  }

  for (const tool of snapshot.toolCalls) {
    rows.push({
      id: `run:${snapshot.runId}:${tool.toolCallId}`,
      runId: snapshot.runId,
      role: 'assistant',
      content: '',
      timestamp: UNKNOWN_TIME,
      seqIndex: firstSequence.get(`tool:${tool.toolCallId}`) ?? null,
      sequenceDomain: 'run-event',
      msgType: 'tool_use',
      tool_call_id: tool.toolCallId,
      toolName: tool.name,
      toolInput: JSON.stringify(tool.arguments ?? tool.provisionalArguments ?? {}),
      status: tool.settled ? 'done' : 'streaming',
      parentToolCallId: tool.groupId,
      durationMs: tool.durationMs,
    });
    if (tool.result !== null) {
      rows.push({
        id: `run:${snapshot.runId}:${tool.toolCallId}:result`,
        runId: snapshot.runId,
        role: 'tool',
        content: tool.result,
        timestamp: UNKNOWN_TIME,
        seqIndex: settlementSequence.get(`tool:${tool.toolCallId}`) ?? null,
        sequenceDomain: 'run-event',
        msgType: 'tool_result',
        tool_call_id: tool.toolCallId,
        toolName: tool.name,
        status: tool.outcome?.outcome === 'tool_error' ? 'error' : 'done',
        durationMs: tool.durationMs,
      });
    }
  }

  return rows.sort((left, right) => (left.seqIndex ?? Number.MAX_SAFE_INTEGER) - (right.seqIndex ?? Number.MAX_SAFE_INTEGER));
}

export function mergeRunSessionRows(durable: readonly Message[], snapshot: RunSessionSnapshot | null): Message[] {
  if (!snapshot) return [...durable];
  return [
    ...durable.filter((message) => (
      message.runId !== snapshot.runId || message.role === 'user'
    )),
    ...runSessionMessages(snapshot),
  ];
}
