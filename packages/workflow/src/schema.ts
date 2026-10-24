/**
 * schema.ts — workflow definition schema (plan 552 §4, amending 415 §3).
 *
 * Top level (§4.1): name / description / when_to_use / params / triggers /
 * phases. Node level (§4.2): SIX node kinds —
 *
 *   ① tool      deterministic instruction, zero LLM, ToolRegistry direct call
 *   ② decision  System One typed decision over 551 DecisionService (§5)
 *   ③ human     human-in-the-loop approval card (498) — the ONLY channel
 *               for irreversible side effects; timeout.on_timeout REQUIRED
 *               so a suspended run can never leak (§12 risk table)
 *   ④ agent     open-ended subtask (SubagentTool)
 *   ⑤ noop      placeholder / join point
 *
 * plus the two primitives `map` (dynamic fan-out over agent/tool) and
 * `when` (conditional edge, evaluated per node).
 *
 * Determinism rule (§6.5): NO clock/random/sleep constructs anywhere —
 * timeouts live in host code or human-node `timeout`.
 */

import { z } from 'zod';

// ─── identifiers ───

export const WORKFLOW_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const NODE_ID_RE = /^[a-z][a-z0-9-]*$/;
export const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;

// ─── params ───

export const WorkflowParamSchema = z.object({
  name: z.string().regex(PARAM_NAME_RE, 'param name must be snake_case'),
  type: z.enum(['string', 'number', 'boolean', 'json']),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});
export type WorkflowParam = z.infer<typeof WorkflowParamSchema>;

// ─── triggers (§7; absent = manual / Slash only) ───

export const CronTriggerSchema = z.object({
  cron: z.string().min(1),
});
export const BotTriggerSchema = z.object({
  bot: z.object({ mention: z.boolean().optional() }).strict(),
});
export const HttpTriggerSchema = z.object({
  http: z.object({ path: z.string().regex(/^\//, 'http path must start with /') }).strict(),
});
export const WorkflowTriggerSchema = z.union([CronTriggerSchema, BotTriggerSchema, HttpTriggerSchema]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

// ─── decision node (§5 — 551 DecisionService consumption) ───

export const ChoiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    /** option label → description. Option list = Object.keys(criteria). */
    criteria: z.record(z.string(), z.string()),
    instructions: z.string().optional(),
  })
  .strict();
export const NoulQuestionSchema = z
  .object({ type: z.literal('noul'), instructions: z.string().min(1) })
  .strict();
export const ScoreQuestionSchema = z
  .object({ type: z.literal('score'), levels: z.array(z.string()).min(2), instructions: z.string().min(1) })
  .strict();
export const DecisionQuestionSchema = z.union([ChoiceQuestionSchema, NoulQuestionSchema, ScoreQuestionSchema]);
export type DecisionQuestionSpec = z.infer<typeof DecisionQuestionSchema>;

/** Per-question gray-band threshold override (0..1); semantics from 551 policy. */
export const DecisionNodeSchema = z
  .object({
    /** State the questions evaluate: `{ output: "${node.output}" }` ref or inline object. */
    state: z.union([z.object({ output: z.string().min(1) }).strict(), z.record(z.string(), z.unknown())]),
    questions: z.record(z.string(), DecisionQuestionSchema),
    thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(),
    on_low_confidence: z
      .union([z.literal('ask'), z.literal('skip'), z.object({ default: z.union([z.string(), z.number(), z.boolean()]) }).strict()])
      .optional(),
  })
  .strict();
export type DecisionNodeSpec = z.infer<typeof DecisionNodeSchema>;

// ─── human node (§4.2 ④ — timeout.on_timeout REQUIRED) ───

export const HumanNodeSchema = z
  .object({
    via: z.literal('approval_card').optional(),
    prompt: z.string().min(1),
    timeout: z
      .object({
        hours: z.number().positive(),
        on_timeout: z.enum(['escalate', 'skip', 'fail']),
      })
      .strict(),
  })
  .strict();
export type HumanNodeSpec = z.infer<typeof HumanNodeSchema>;

// ─── agent node (§4.2 ⑤) ───

export const AgentNodeSchema = z
  .object({
    agent: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().optional(),
    /** Loose JSON-schema object; host validates + 1 retry (§4.2 constraint c). */
    output_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AgentNodeSpec = z.infer<typeof AgentNodeSchema>;

// ─── tool / noop ───

export const ToolNodeSchema = z
  .object({
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ToolNodeSpec = z.infer<typeof ToolNodeSchema>;

export const NoopNodeSchema = z.object({ noop: z.literal(true) }).strict();

// ─── map primitive (415 §4.2 — fan-out over agent/tool) ───

export const MapPrimitiveSchema = z
  .object({
    over: z.string().min(1),
    as: z.string().regex(PARAM_NAME_RE, 'map `as` must be a valid variable name'),
    parallel: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
    prompt: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type MapPrimitive = z.infer<typeof MapPrimitiveSchema>;

// ─── node ───

const NodeBase = {
  id: z.string().regex(NODE_ID_RE, 'node id must be kebab-case'),
  /** Conditional edge; false → node skipped (recorded, not blocking). */
  when: z.string().optional(),
  on_error: z.enum(['skip', 'fail', 'retry']).optional(),
  max_retries: z.number().int().min(0).max(3).optional(),
  /** Verification annotation target (plan 552 §2 principle 4). */
  map: MapPrimitiveSchema.optional(),
};

export const WorkflowNodeSchema = z
  .object({
    ...NodeBase,
    tool: z.string().min(1).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    decision: DecisionNodeSchema.optional(),
    human: HumanNodeSchema.optional(),
    agent: z.string().min(1).optional(),
    prompt: z.string().optional(),
    model: z.string().optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    noop: z.literal(true).optional(),
  })
  .refine((n) => {
    const kinds = [n.tool, n.decision, n.human, n.agent, n.noop].filter((v) => v !== undefined).length;
    if (kinds === 1) return true;
    // map wraps exactly one agent or tool
    if (n.map && n.agent && !n.tool && !n.decision && !n.human && !n.noop) return true;
    return false;
  }, 'node must declare exactly one of tool / decision / human / agent / noop (map may wrap exactly one agent)');
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

// ─── phase + top level (§4.1) ───

export const WorkflowPhaseSchema = z
  .object({
    phase: z.string().regex(NODE_ID_RE, 'phase id must be kebab-case'),
    title: z.string().min(1).max(128),
    detail: z.string().max(1024).optional(),
    nodes: z.array(WorkflowNodeSchema).min(1),
  })
  .strict();
export type WorkflowPhase = z.infer<typeof WorkflowPhaseSchema>;

export const WorkflowDefSchema = z
  .object({
    name: z.string().regex(WORKFLOW_NAME_RE, 'workflow name must be kebab-case').max(64),
    description: z.string().min(1).max(1024),
    when_to_use: z.string().max(2048).optional(),
    params: z.array(WorkflowParamSchema).optional(),
    triggers: z.array(WorkflowTriggerSchema).optional(),
    phases: z.array(WorkflowPhaseSchema).min(1).max(8),
  })
  .strict();
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

/** Budget / concurrency defaults (plan 552 §6.5, grok lib.rs:16-19 aligned). */
export const WORKFLOW_BUDGET_DEFAULTS = {
  /** agent-call (LLM) budget default. */
  agentBudget: 128,
  /** agent-call budget hard cap. */
  agentBudgetMax: 1024,
  /** host-call total cap (gui steps + agent calls + decisions). */
  hostCallCap: 10_000,
  /** map concurrency default (overridden per node, ≤16). */
  mapConcurrency: 4,
} as const;

/** Parse + validate raw data into a WorkflowDef. Throws a zod error. */
export function parseWorkflowDef(raw: unknown): WorkflowDef {
  return WorkflowDefSchema.parse(raw);
}
