/**
 * subagentResult.ts — typed result contract for the `task` (SubagentTool) tool.
 *
 * Before plan 571 every exit path in `SubagentTool.execute()` hand-rolled its
 * own `JSON.stringify({...})`, so the receipt the model (and the renderer)
 * saw had a different shape depending on which branch produced it: a spawn
 * receipt had `status: 'running'`, a completion receipt had no `status` at
 * all, and a failure receipt had only `error`. The renderer's parser
 * (`src/lib/subagent-result.ts`) then had to guess.
 *
 * This module is the single place that builds and validates the wire payload.
 * The field names here are load-bearing: the renderer parser is written
 * against exactly this shape (it additionally tolerates the pre-571 legacy
 * names when reading already-persisted history, but nothing emits them).
 *
 * The zod schema is intentionally permissive about *absent* optional fields
 * and strict about their *types*, so a partially-populated receipt still
 * serializes while a malformed one is caught before it reaches the model.
 */

import { z } from 'zod';

// ============================================================================
// Status vocabulary
// ============================================================================

/**
 * Lifecycle status of one sub-agent run.
 *
 * Mirrors `SubagentRunStatus` in `src/lib/subagent-status.ts`. It is
 * duplicated rather than imported because `packages/agent` is a standalone
 * workspace package and must not depend on the renderer's `src/` tree. The
 * two must be kept in sync — the renderer is the consumer of this union.
 */
export const SUBAGENT_RUN_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
] as const;

export type SubagentRunStatus = (typeof SUBAGENT_RUN_STATUSES)[number];

// ============================================================================
// permission_mode
// ============================================================================

/**
 * `permission_mode` vocabulary, identical to the worker-level agent mode
 * (`AgentPermissionMode` in `process/permission-profile-bridge.ts`) so the
 * model does not have to learn a second permission dialect for sub-agents.
 */
export const SUBAGENT_PERMISSION_MODES = ['default', 'auto', 'bypassPermissions'] as const;

export type SubagentPermissionMode = (typeof SUBAGENT_PERMISSION_MODES)[number];

/**
 * Validate a model-supplied `permission_mode`. Returns undefined for
 * anything unrecognized so the caller can inherit the parent session's mode
 * rather than silently downgrading to a guess.
 */
export function normalizePermissionMode(value: unknown): SubagentPermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return (SUBAGENT_PERMISSION_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as SubagentPermissionMode)
    : undefined;
}

// ============================================================================
// effort
// ============================================================================

/**
 * `effort` vocabulary — the same thinking-budget levels the main session's
 * `StartStreamParams.effort` accepts. `off` disables extended thinking; the
 * remaining keys are exactly the `BUDGET` table the Anthropic client maps to
 * `thinking.budget_tokens` (see `resolveAnthropicThinking` in
 * `packages/ai/src/api/anthropic-messages.ts`), so every value here has a
 * real effect on the request body.
 */
export const SUBAGENT_EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type SubagentEffort = (typeof SUBAGENT_EFFORT_LEVELS)[number];

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(SUBAGENT_EFFORT_LEVELS);

/** Case-insensitive effort validation; unknown values are dropped. */
export function normalizeEffort(value: unknown): SubagentEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return EFFORT_LEVEL_SET.has(trimmed) ? (trimmed as SubagentEffort) : undefined;
}

// ============================================================================
// tools overlay
// ============================================================================

/** Per-call overlay applied on top of the agent definition's tool list. */
export interface SubagentToolOverlay {
  allow?: string[];
  deny?: string[];
}

const toolOverlaySchema = z.strictObject({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
});

/**
 * Validate the model's `tools: { allow?, deny? }` overlay. Returns undefined
 * when nothing usable was supplied so `RunAgentParams.toolOverlay` stays
 * absent rather than an empty object (which would read as "deny nothing /
 * allow nothing" to a careless caller).
 */
export function normalizeToolOverlay(value: unknown): SubagentToolOverlay | undefined {
  const parsed = toolOverlaySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { allow, deny } = parsed.data;
  if (!allow?.length && !deny?.length) return undefined;
  return {
    ...(allow?.length ? { allow: [...allow] } : {}),
    ...(deny?.length ? { deny: [...deny] } : {}),
  };
}

// ============================================================================
// Result payload
// ============================================================================

export const subagentUsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

/**
 * The wire shape of a `task` tool receipt. Field names are contractual — see
 * `parseSubAgentToolResult` in `src/lib/subagent-result.ts`.
 *
 * `strictObject` (not `.strict()`): it rejects an unrecognized key, so a
 * misspelled field fails here instead of shipping as a receipt the renderer
 * silently ignores.
 */
export const subagentToolResultSchema = z.strictObject({
  status: z.enum(SUBAGENT_RUN_STATUSES),
  /** Type the model asked for (pre-alias-resolution). */
  agentType: z.string().min(1),
  /** Type actually resolved against the agent registry. */
  resolvedAgentType: z.string().min(1),
  description: z.string().optional(),
  content: z.string(),
  /** The sub-agent's own session id — the side panel's conversation identity. */
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  taskId: z.string().min(1),
  background: z.boolean(),
  /** Path to the on-disk jsonl transcript. */
  outputFilePath: z.string().min(1).optional(),
  totalToolUseCount: z.number().int().nonnegative().default(0),
  totalDurationMs: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  usage: subagentUsageSchema.optional(),
  /** Directory the child actually ran in (differs under worktree isolation). */
  workingDirectory: z.string().min(1).optional(),
  isolation: z.literal('worktree').optional(),
  /** Non-fatal notes (e.g. resume_from fell back to a fresh session). */
  warnings: z.array(z.string().min(1)).optional(),
  error: z.string().min(1).optional(),
});

export type SubagentToolResultPayload = z.infer<typeof subagentToolResultSchema>;

/** Input accepted by {@link buildSubagentResult} — every required identity
 * field is mandatory so a receipt can never be emitted without something the
 * renderer needs to attach a row to a session. */
export interface BuildSubagentResultInput {
  status: SubagentRunStatus;
  agentType: string;
  resolvedAgentType: string;
  sessionId: string;
  agentId: string;
  taskId: string;
  content: string;
  background: boolean;
  description?: string;
  outputFilePath?: string;
  totalToolUseCount?: number;
  totalDurationMs?: number;
  totalTokens?: number;
  usage?: SubagentToolResultPayload['usage'];
  workingDirectory?: string;
  isolation?: 'worktree';
  warnings?: string[];
  error?: string;
}

/**
 * Build a validated receipt. Throws on a malformed payload — every call site
 * is inside `SubagentTool.execute()`'s try block, so a contract violation
 * surfaces as a structured tool error rather than as an unvalidated blob the
 * model has to interpret.
 */
export function buildSubagentResult(input: BuildSubagentResultInput): SubagentToolResultPayload {
  return subagentToolResultSchema.parse({
    status: input.status,
    agentType: input.agentType,
    resolvedAgentType: input.resolvedAgentType,
    sessionId: input.sessionId,
    agentId: input.agentId,
    taskId: input.taskId,
    content: input.content,
    background: input.background,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.outputFilePath ? { outputFilePath: input.outputFilePath } : {}),
    totalToolUseCount: input.totalToolUseCount ?? 0,
    totalDurationMs: input.totalDurationMs ?? 0,
    totalTokens: input.totalTokens ?? 0,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
    ...(input.error ? { error: input.error } : {}),
  });
}

/** Validate + serialize in one step. This is what `execute()` returns. */
export function serializeSubagentResult(input: BuildSubagentResultInput): string {
  return JSON.stringify(buildSubagentResult(input));
}
