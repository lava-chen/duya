/**
 * UpdateStateTool — Plan 481 T1 (schema/permission/registration owner;
 * write side connects to the Plan 479 tier store through the
 * memory-tier IPC bridge).
 *
 * Grok semantics (479 §3.3): target=memory|project, scope=agent|user|project,
 * action=write|forget (project adds create/join/leave). Single-writer rule:
 * a bot can only write its own shard — shared facts are written as
 * corrections into the writer's own shard (newest-wins dedupe).
 *
 * Tier mapping (Plan 479 store):
 *   (memory, agent)   → tier 'agent'    — the bot's own memory
 *   (memory, user)    → tier 'user'     — the bot's shard of the user tier
 *   (project, project)→ tier 'project'  — the bot's shard of that project
 *
 * Permission matrix (Plan 481 §3): own tier = allow; user/project writes
 * and project membership actions = ask (executor's checkPermissions stage,
 * plan 419 bus); invalid combinations = deny.
 */

import type { ToolResult, Tool, ToolUseContext } from '../../types.js';
import type { PermissionCheckResult, ToolContext } from '../types.js';
import {
  MAX_FACT_CHARS,
  MAX_PROJECT_CHARS,
  UPDATE_STATE_TOOL_NAME,
  type MemoryTier,
  type TierEntryKind,
  type UpdateStateErrorCode,
} from './constants.js';

// ============================================================
// Bridge contract
// ============================================================

/** Payload sent over the memory-tier bridge (IPC or injected test double). */
export interface MemoryTierWritePayload {
  actorAgentId: string;
  tier: MemoryTier;
  action: 'write' | 'forget' | 'create' | 'join' | 'leave';
  /** Clamped fact text (write) or the fact/key text to forget. */
  fact: string;
  /** Normalized dedupe key derived from the fact. */
  dedupeKey: string;
  /** Project id — required for tier='project' and membership actions. */
  project?: string;
  kind: TierEntryKind;
}

export interface MemoryTierBridgeResponse {
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export type MemoryTierBridge = (
  payload: MemoryTierWritePayload,
  context?: ToolUseContext,
) => Promise<MemoryTierBridgeResponse>;

// ============================================================
// Input resolution — shared by checkPermissions and execute
// ============================================================

export interface UpdateStateInput {
  target: 'memory' | 'project';
  scope: 'agent' | 'user' | 'project';
  action: 'write' | 'forget' | 'create' | 'join' | 'leave';
  project?: string;
  fact?: string;
  kind?: string;
}

export type ResolvedOperation =
  | {
      ok: true;
      tier: MemoryTier;
      needsProject: boolean;
      /** ask vs allow at the permission stage. */
      sharedLayer: boolean;
      /** create/join/leave are structured no-ops until 479 Phase 3. */
      membership: boolean;
      fact: string;
      dedupeKey: string;
    }
  | { ok: false; code: UpdateStateErrorCode; message: string };

/** Lowercase + collapse whitespace — mirrors the 479 dedupe_key normalization. */
export function normalizeDedupeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function resolveUpdateStateOperation(input: unknown): ResolvedOperation {
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'update_state input must be an object.' };
  }
  const raw = input as Record<string, unknown>;
  const target = raw.target;
  const scope = raw.scope;
  const action = raw.action;

  if (target !== 'memory' && target !== 'project') {
    return { ok: false, code: 'INVALID_INPUT', message: "target must be 'memory' or 'project'." };
  }
  if (scope !== 'agent' && scope !== 'user' && scope !== 'project') {
    return { ok: false, code: 'INVALID_INPUT', message: "scope must be 'agent', 'user' or 'project'." };
  }
  if (action !== 'write' && action !== 'forget' && action !== 'create' && action !== 'join' && action !== 'leave') {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: "action must be 'write', 'forget', 'create', 'join' or 'leave'.",
    };
  }

  const membership = action === 'create' || action === 'join' || action === 'leave';
  if (membership && target !== 'project') {
    return { ok: false, code: 'INVALID_INPUT', message: `${action} is only valid with target='project'.` };
  }

  let project: string | undefined;
  if (raw.project !== undefined) {
    if (typeof raw.project !== 'string' || raw.project.trim().length === 0) {
      return { ok: false, code: 'INVALID_INPUT', message: 'project must be a non-empty string.' };
    }
    project = raw.project.trim().slice(0, MAX_PROJECT_CHARS);
  }

  if (target === 'project') {
    if (scope !== 'project') {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: "target='project' requires scope='project' (you always write your own shard).",
      };
    }
    if (!project) {
      return { ok: false, code: 'INVALID_INPUT', message: "target='project' requires the project field." };
    }
  } else if (scope === 'project') {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: "scope='project' is only valid with target='project'.",
    };
  }

  const tier: MemoryTier = target === 'project' ? 'project' : scope === 'agent' ? 'agent' : 'user';

  const kindRaw = typeof raw.kind === 'string' ? raw.kind : undefined;
  const kind: TierEntryKind =
    kindRaw === 'profile' || kindRaw === 'log' || kindRaw === 'note' ? kindRaw : 'note';

  let fact = '';
  if (action === 'write' || action === 'forget') {
    if (typeof raw.fact !== 'string' || raw.fact.trim().length === 0) {
      return { ok: false, code: 'INVALID_INPUT', message: `${action} requires a non-empty fact.` };
    }
    fact = raw.fact.trim().slice(0, MAX_FACT_CHARS);
  }

  return {
    ok: true,
    tier,
    needsProject: tier === 'project',
    // own tier writes are pre-approved; user/project layers and membership
    // changes touch shared state → ask.
    sharedLayer: tier !== 'agent' || membership,
    membership,
    fact,
    dedupeKey: fact ? normalizeDedupeKey(fact) : '',
  };
}

// ============================================================
// Result helpers
// ============================================================

function structuredResult(
  name: string,
  payload: Record<string, unknown>,
  error?: boolean,
): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

// ============================================================
// Tool
// ============================================================

export class UpdateStateTool implements Tool {
  readonly name = UPDATE_STATE_TOOL_NAME;

  readonly description = `Persist or retract durable facts in your long-term memory (update_state).

- target='memory', scope='agent': your own private memory (default choice). Allowed without confirmation.
- target='memory', scope='user': your shard of the user-level shared memory. Requires user confirmation.
- target='project', scope='project': your shard of a project's shared memory (pass project id). Requires user confirmation.
- action='write' stores a short fact (≤ ${MAX_FACT_CHARS} chars); re-writing the same fact updates it (newest wins).
- action='forget' retracts a previously stored fact (pass its exact text).
- action='create'/'join'/'leave' manage project membership (target='project' + project id).

Write durable, self-contained facts (preferences, decisions, corrections). Do not store secrets, transient state, or conversation logs.`;

  readonly input_schema = {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['memory', 'project'],
        description: "What to update: 'memory' stores a fact, 'project' manages project memory/membership.",
      },
      scope: {
        type: 'string',
        enum: ['agent', 'user', 'project'],
        description: "Where it lands: 'agent' = your private memory, 'user' = shared user memory, 'project' = project memory (requires project).",
      },
      action: {
        type: 'string',
        enum: ['write', 'forget', 'create', 'join', 'leave'],
        description: "'write'/'forget' store or retract facts; 'create'/'join'/'leave' manage project membership.",
      },
      project: {
        type: 'string',
        description: 'Project id. Required when target="project".',
      },
      fact: {
        type: 'string',
        description: `The fact text (≤ ${MAX_FACT_CHARS} chars). Required for write/forget. For forget, pass the exact previously stored text.`,
      },
      kind: {
        type: 'string',
        enum: ['profile', 'log', 'note'],
        description: "Entry kind. Defaults to 'note'; use 'profile' for durable identity/preference facts.",
      },
    },
    required: ['target', 'scope', 'action'],
  };

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  // ----------------------------------------------------------
  // Permissions (Plan 419 bus: the executor consults this before execute)
  // ----------------------------------------------------------
  checkPermissions(input: unknown, _context: ToolContext): PermissionCheckResult {
    const resolved = resolveUpdateStateOperation(input);
    if (!resolved.ok) {
      return { allowed: false, reason: resolved.message };
    }
    if (resolved.sharedLayer) {
      return {
        allowed: true,
        requiresUserConfirmation: true,
        reason:
          resolved.membership
            ? `Project membership change (${resolved.tier} tier) requires user confirmation.`
            : `Writing to the shared ${resolved.tier} tier requires user confirmation.`,
      };
    }
    return { allowed: true, reason: 'Own-tier memory write (pre-approved).' };
  }

  // ----------------------------------------------------------
  // Execution
  // ----------------------------------------------------------
  async execute(
    input: Record<string, unknown>,
    _wd?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const resolved = resolveUpdateStateOperation(input);
    if (!resolved.ok) {
      return structuredResult(this.name, {
        success: false,
        error: { code: resolved.code, message: resolved.message },
      }, true);
    }

    const actorAgentId = context?.options?.agentProfileId;
    if (!actorAgentId) {
      return structuredResult(this.name, {
        success: false,
        error: {
          code: 'NO_IDENTITY',
          message: 'No agent identity is bound to this session; memory writes require a bot profile.',
        },
      }, true);
    }

    if (resolved.membership) {
      // Membership storage arrives with 479 Phase 3 / the project model.
      // The shell keeps the schema + permission surface stable (Plan 481 §3).
      return structuredResult(this.name, {
        success: false,
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Project membership management is not available yet (plan 479 phase 3).',
        },
      }, true);
    }

    const bridge = this.resolveBridge(context);
    if (!bridge) {
      return structuredResult(this.name, {
        success: false,
        error: {
          code: 'NO_BRIDGE',
          message: 'Memory tier bridge is not available in this runtime.',
        },
      }, true);
    }

    const payload: MemoryTierWritePayload = {
      actorAgentId,
      tier: resolved.tier,
      action: input.action as 'write' | 'forget',
      fact: resolved.fact,
      dedupeKey: resolved.dedupeKey,
      ...(resolved.needsProject ? { project: (input.project as string).trim().slice(0, MAX_PROJECT_CHARS) } : {}),
      kind: (typeof input.kind === 'string' && ['profile', 'log', 'note'].includes(input.kind)
        ? input.kind
        : 'note') as TierEntryKind,
    };

    let response: MemoryTierBridgeResponse;
    try {
      response = await bridge(payload, context);
    } catch (err) {
      return structuredResult(this.name, {
        success: false,
        error: {
          code: 'BRIDGE_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      }, true);
    }

    if (!response.success) {
      return structuredResult(this.name, {
        success: false,
        error: response.error ?? { code: 'BRIDGE_ERROR', message: 'Memory tier write failed.' },
      }, true);
    }

    return structuredResult(this.name, {
      success: true,
      tier: payload.tier,
      action: payload.action,
      dedupeKey: payload.dedupeKey,
      outcome: response.result,
    });
  }

  /**
   * Bridge resolution: an injected test bridge wins (deterministic unit
   * tests), otherwise the executor's ToolUseContext.ipcRequest routes to
   * the main-process memory-tier dispatcher.
   */
  private resolveBridge(context?: ToolUseContext): MemoryTierBridge | null {
    if (injectedBridge) return injectedBridge;
    if (context?.ipcRequest) {
      return async (payload, ctx) => {
        const response = await ctx!.ipcRequest!(
          'memory-tier:rpc',
          { action: payload.action, payload },
          { timeout: 15_000 },
        );
        return {
          success: response.success,
          result: response.data,
          error: response.error,
        };
      };
    }
    return null;
  }
}

let injectedBridge: MemoryTierBridge | null = null;

/** Install a test bridge (Plan 481 harness pattern; pass null to reset). */
export function setMemoryTierBridge(bridge: MemoryTierBridge | null): void {
  injectedBridge = bridge;
}

export const updateStateTool = new UpdateStateTool();
