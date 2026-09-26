/**
 * System-reminder source taxonomy (plan 567, ZCode source.ts parity).
 *
 * Every `<system-reminder>` injection site declares its source here so the
 * lifecycle of each injected block is explicit instead of implicit:
 *
 *   - channel      — where the block enters the conversation
 *                    (system prompt field / per-turn preamble / mid-turn
 *                    user-role injection / tool_result tail)
 *   - lifecycle    — how the block survives across requests
 *                    (persistent = always re-rendered or lives in the system
 *                    field; per_request = re-injected each request and
 *                    deduped by content hash; one_shot = injected once per
 *                    session, must be released for re-injection after a
 *                    compaction drops it; transient = regenerated per turn
 *                    by its owner, never re-injected)
 *   - persisted    — whether the block rides inside the persisted timeline
 *   - evidenceLabel— stable identifier for diagnostics / log correlation
 *
 * ZCode also declares `providerVisibility`; duya has no hidden-reminder
 * channel today, so the axis is omitted (see plan 567 non-goals).
 */

/** Where the block enters the conversation. */
export type ReminderChannel =
  | 'system_prefix'
  | 'per_turn'
  | 'mid_turn'
  | 'tool_result';

/** How the block survives across model requests. */
export type ReminderLifecycle = 'persistent' | 'per_request' | 'one_shot' | 'transient';

export interface ReminderSourceDescriptor {
  channel: ReminderChannel;
  lifecycle: ReminderLifecycle;
  /** Block rides inside the persisted timeline (vs working-array-only). */
  persisted: boolean;
  /** Stable identifier for diagnostics / log correlation. */
  evidenceLabel: string;
}

export type ReminderSourceId =
  | 'project_instructions'
  | 'agent_global_instructions'
  | 'nested_agents_md'
  | 'plan_mode'
  | 'goal_continuation'
  | 'research_continuation'
  | 'loop_nudge'
  | 'hook_context_rail'
  | 'pre_tool_use_advisory'
  | 'git_safety'
  | 'background_notification';

const REMINDER_SOURCE_DESCRIPTORS: Record<ReminderSourceId, ReminderSourceDescriptor> = {
  // AGENTS.md snapshot in the system field (plan 408 Phase 5): always
  // re-rendered by the prompt build, never part of the message timeline.
  project_instructions: {
    channel: 'system_prefix',
    lifecycle: 'persistent',
    persisted: false,
    evidenceLabel: 'sr.project_instructions',
  },
  // Config-driven agent global instructions ([agents.<id>], plan 424),
  // appended to the system field alongside project instructions.
  agent_global_instructions: {
    channel: 'system_prefix',
    lifecycle: 'persistent',
    persisted: false,
    evidenceLabel: 'sr.agent_global_instructions',
  },
  // Subtree AGENTS.md / conditional rules pulled in by file-touching tools
  // (plan 408b). One-shot per session; after a compaction drops the injected
  // message the manager must release the loaded set so the next trigger
  // re-injects it (plan 567 §C).
  nested_agents_md: {
    channel: 'mid_turn',
    lifecycle: 'one_shot',
    persisted: true,
    evidenceLabel: 'sr.nested_agents_md',
  },
  // Plan-task mode preamble (full/sparse/reentry/exit alternation, plan 413).
  plan_mode: {
    channel: 'per_turn',
    lifecycle: 'transient',
    persisted: false,
    evidenceLabel: 'sr.plan_mode',
  },
  // Goal per-round continuation (plan 411).
  goal_continuation: {
    channel: 'per_turn',
    lifecycle: 'transient',
    persisted: false,
    evidenceLabel: 'sr.goal_continuation',
  },
  // Research per-round continuation (plan 423).
  research_continuation: {
    channel: 'per_turn',
    lifecycle: 'transient',
    persisted: false,
    evidenceLabel: 'sr.research_continuation',
  },
  // Loop-hook nudges (dead-loop / premature-stop, injected
  // through the RuntimeContextMessage framework with transient persistence).
  loop_nudge: {
    channel: 'mid_turn',
    lifecycle: 'transient',
    persisted: false,
    evidenceLabel: 'sr.loop_nudge',
  },
  // The promptContexts rail: hook/context blocks that are re-projected into
  // every streaming request (ensure-present semantics) and deduped by hash.
  hook_context_rail: {
    channel: 'mid_turn',
    lifecycle: 'per_request',
    persisted: false,
    evidenceLabel: 'sr.hook_context_rail',
  },
  // PreToolUse advisory envelopes: replace-last per tool, re-injected each
  // request when the hook fires again.
  pre_tool_use_advisory: {
    channel: 'mid_turn',
    lifecycle: 'per_request',
    persisted: false,
    evidenceLabel: 'sr.pre_tool_use_advisory',
  },
  // Git-safety reminder appended to BashTool tool_result on git invocations.
  git_safety: {
    channel: 'tool_result',
    lifecycle: 'per_request',
    persisted: false,
    evidenceLabel: 'sr.git_safety',
  },
  // Background-task notifications claimed from the mailbox at a run
  // checkpoint (`<task-notification>` XML). Transient: the row is applied in
  // the mailbox (its state machine is the durable record); only the framed
  // envelope reaches the working message array, never the persisted timeline.
  background_notification: {
    channel: 'mid_turn',
    lifecycle: 'transient',
    persisted: false,
    evidenceLabel: 'sr.background_notification',
  },
};

/** All registered source ids (exhaustive — the record type guarantees it). */
export const REMINDER_SOURCE_IDS = Object.keys(
  REMINDER_SOURCE_DESCRIPTORS,
) as ReminderSourceId[];

export function getReminderSourceDescriptor(
  source: ReminderSourceId,
): ReminderSourceDescriptor {
  const descriptor = (REMINDER_SOURCE_DESCRIPTORS as Record<string, ReminderSourceDescriptor>)[
    source as string
  ];
  if (!descriptor) {
    // Fail loudly: an off-taxonomy reminder source must be registered here
    // first, not silently injected with implicit lifecycle semantics.
    throw new Error(`Unknown system-reminder source: ${String(source)}`);
  }
  return descriptor;
}

/**
 * Escape literal `<system-reminder>` tags inside a reminder body (plan 567
 * §B, ZCode `escapeNestedSystemReminderTags` parity). A body that carries the
 * envelope tag itself would confuse both the model's block-boundary parsing
 * and the forged-strip regex on the outgoing payload. Case/whitespace
 * variants are covered; only the leading `<` is escaped so the text stays
 * human-readable.
 */
const NESTED_REMINDER_TAG_PATTERN = /<\/?system-reminder\b/gi;

export function sanitizeSystemReminderBody(body: string): string {
  return body.replace(NESTED_REMINDER_TAG_PATTERN, (tag) => `&lt;${tag.slice(1)}`);
}
