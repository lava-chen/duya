/**
 * Permission and progress shapes shared across the wire.
 *
 * ## Why these moved and what did not
 *
 * These two are named the same in four places with four different field sets,
 * which is the concrete form of "one source of truth" being missing:
 *
 * | Surface                              | Fields | Extra vs. the type here |
 * | ------------------------------------ | ------ | ------------------------ |
 * | protocol `PermissionRequest`         | own set | canonical, 3 vocabularies |
 * | `@duya/ai` `PermissionRequestEvent`  | 7      | —                         |
 * | `apps/desktop` `PermissionRequestEvent` | 9   | `connector`, `suggestions` |
 * | `worker-protocol` `AgentPermissionEvent` | 3   | request is flattened      |
 *
 * The Desktop one is a SUPERSET of the `@duya/ai` one. That is why the two
 * were not merged: pointing Desktop at the `@duya/ai` shape would compile and
 * silently stop carrying `connector` and `suggestions`, so the approval card
 * would lose "Always allow" for app-connection tools. Merging them is real
 * behaviour work and belongs in the router cutover PR, not here.
 *
 * What this file does is give the `@duya/ai` shape an owner, and record the
 * divergence in `classification.ts` so the next PR cannot miss it.
 *
 * @see ../permission.ts for the protocol's own permission vocabulary
 */

/**
 * Plan 450 Phase D: structured parameter display. The renderer surfaces these
 * as tidy label:value rows above the raw input JSON.
 */
export type ConnectorToolParamsDisplayEntry = {
  name: string;
  label: string;
  value: string;
};

/**
 * A permission request as it travels on the legacy SSE wire.
 *
 * Distinct from the protocol's `PermissionRequest` on purpose. The protocol
 * type separates the request, the policy decision (`allow`/`ask`/`deny`) and
 * the response (`allow`/`allow_always`/`deny`/`defer`) into three vocabularies
 * (contract §E); this one is a single flattened blob where `mode` is the
 * request's interactive situation and the response does not appear at all.
 * Collapsing them would reintroduce the ambiguity R2.4 removed.
 */
export interface PermissionRequestEvent {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** The request's interactive situation, NOT the policy decision. */
  mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
  expiresAt: number;
  decisionReason?: string;
  /**
   * Optional structured metadata attached by the agent core (Plan 450).
   * Currently used to carry `toolParamsDisplay` for connector tools so
   * the approval card can render a labeled summary instead of raw JSON.
   */
  metadata?: { toolParamsDisplay?: ConnectorToolParamsDisplayEntry[] };
}

/** Hook invocation detail, nested by the runtime so the flat envelope passes
 *  through unchanged. The renderer unwraps it in `handleAgentProgressEvent`. */
export interface HookEventPayload {
  hookEventName: string;
  hookType: 'command' | 'process' | 'prompt' | 'http' | 'agent';
  hookName: string;
  matcher?: string;
  additionalContext?: string;
  exitCode?: number;
  async: boolean;
  backgroundTaskId?: string;
  durationMs: number;
  status: 'ok' | 'error' | 'timeout' | 'skipped';
  errorMessage?: string;
  seq: number;
  toolName?: string;
  toolUseId?: string;
}

/**
 * Sub-agent progress, flattened onto one type with a `type` discriminant.
 *
 * `heartbeat` is missing from this union on purpose and the omission is
 * recorded, not fixed: `worker-protocol.ts` documents that `heartbeat` is a
 * distinct member of the WORKER union (`SubagentAgentEventType`) precisely so
 * a keepalive is not rendered as model reasoning, while this legacy union was
 * never widened to match. Adding `heartbeat` here would let a producer emit a
 * keepalive that the renderer then cannot distinguish from real output. See
 * `classification.ts` and plan 587 T3.1 removal task 587-T3-1-BEATHOO.
 */
export interface AgentProgressEvent {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'started'
    | 'done'
    | 'error'
    | 'hook_invoked';
  data?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  duration?: number;
  agentId?: string;
  agentType?: string;
  agentName?: string;
  agentDescription?: string;
  sessionId?: string;
  /**
   * Plan 437: when `type === 'hook_invoked'`, the rest of the payload is
   * carried as a nested object so the existing flat envelope passes through
   * unchanged.
   */
  hookEvent?: HookEventPayload;
}

/** Every `AgentProgressEvent['type']`, closed so the renderer can switch. */
export const AGENT_PROGRESS_TYPES = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'started',
  'done',
  'error',
  'hook_invoked',
] as const;

/** Every `PermissionRequestEvent['mode']`, the third permission vocabulary. */
export const PERMISSION_REQUEST_MODES = ['generic', 'ask_user_question', 'exit_plan_mode'] as const;
