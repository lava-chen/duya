/**
 * Legacy event vocabulary — the `{ type, data }` shape every agent-server
 * client already parses.
 *
 * ## Why this file exists
 *
 * `normalizeWorkerEvent` in `apps/desktop/src/main/agents/server/router.ts:450`
 * has, over time, become the de-facto contract between the agent and every
 * consumer of it: the renderer's SSE parser, the reconnect path, the eval
 * harness, and the gateway. Its doc comment states the rule plainly — the POST
 * and GET paths "MUST emit this identical shape", because the renderer reads
 * `event.data.content`.
 *
 * That contract is not written down anywhere as a type. It is a 200-line
 * `if/else` chain whose output every other file reverse-engineers. This module
 * names it, so the projector has a target and the tests have something to pin
 * against.
 *
 * ## The `{ type, data }` shape is not the `@duya/ai` `SSEEvent` union
 *
 * The declared union says `{ type: 'text'; data: string }`, but the router
 * actually sends `{ type: 'text', data: { content: string } }` and the renderer
 * reads `event.data.content`. The declared type is a lie that has been load-
 * bearing for a long time — the protocol package's own bridge module records it
 * (`packages/agent-protocol/src/legacy/sse-event.ts:76`). `LegacySseFrame` is
 * typed the way the wire ACTUALLY behaves, not the way the union claims, and
 * `legacy-sse-projector.ts` is tested against that.
 */

/** The frame every agent-server client receives on the SSE stream. */
export interface LegacySseFrame {
  readonly type: string;
  readonly data?: unknown;
  /**
   * The SSE `id:` field. Minted by the router today and reset per turn; the
   * Reference Run does not touch it. See the plan's §5 "The `seq` decision".
   */
  readonly id?: number;
}

/**
 * Every `type` the router can emit.
 *
 * Three groups, and the grouping is the interesting part:
 *
 *  - **Modelled** — a protocol `RunEvent` exists and is produced from this.
 *  - **Unmodelled** — a real event the renderer depends on with no protocol
 *    counterpart. They still have to reach the UI, so the projector forwards
 *    them by carrying the frame through untouched rather than dropping it.
 *  - **Internal** — never reaches a client at all.
 */
export const LEGACY_SSE_TYPES = [
  // modelled
  'text',
  'text_delta',
  'thinking',
  'thinking_delta',
  'tool_use_started',
  'tool_use_delta',
  'tool_use',
  'tool_result',
  'tool_progress',
  'tool_group_progress',
  'permission',
  'turn_start',
  'done',
  'error',
  'token_usage',
  'status',
  'mode_changed',
  'goal_updated',
  'retry',
  'compact:start',
  'compact:done',
  'compact:error',
  'compact:step',
  'compact:over_threshold',
  'agent_progress',
  // unmodelled, but the UI depends on them
  'clipboard_write',
  'connector_auth_required',
  'workflow_run',
  'research_continue',
  'research_evidence',
  'research_report',
  'db_persisted',
  'title_generated',
  'mcp:reloaded',
  'mcp:status:snapshot',
  'mcp:reload:error',
] as const;

export type LegacySseType = (typeof LEGACY_SSE_TYPES)[number];

/**
 * Types that must never reach a client.
 *
 * `pong` is the worker heartbeat and `memory:wakeup` is a control-plane trigger
 * the POST path acts on locally. Both are dropped by the router before
 * normalisation, and the runtime drops them again on the way in — a second,
 * independent guard, because a heartbeat leaking into a transcript is the kind
 * of thing that is only noticed months later.
 */
export const INTERNAL_SSE_TYPES: ReadonlySet<string> = new Set(['pong', 'memory:wakeup']);

/** True when a frame's type is a heartbeat or control-plane trigger. */
export function isInternalSseType(type: string): boolean {
  return INTERNAL_SSE_TYPES.has(type);
}

/**
 * Read `data.content` from a frame, whichever of the two shapes it has.
 *
 * Both exist in the wild: `chat:text` carries a bare string in `data` while
 * `compact:*` and the pass-through events carry an object. The renderer's
 * parser tolerates both, so the runtime does too rather than asserting one.
 */
export function readTextContent(frame: LegacySseFrame): string {
  const { data } = frame;
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}
