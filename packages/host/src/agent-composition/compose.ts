/**
 * Plan 624 v2 — the single composition entry point.
 *
 * Before this module the seven dimension resolvers were called from seven
 * different places inside `WorkerSession` (constructor, `beginRun`,
 * `_readOrchestratorMode`, `applyTurnModes`, `_resolveTools`,
 * `_buildSystemPrompt`, `_dispatchOrchestratorMode`). Each call site could
 * pass a different slice of the request, so there was no object that answered
 * "what did this turn actually decide?".
 *
 * `composeAgent()` is that object. It is:
 *   - PURE: no clock reads, no IO, no singleton lookups. Every fact a decision
 *     needs arrives through `CompositionInput`.
 *   - TOTAL: it produces all seven dimensions in one call, so a new control
 *     surface (desktop / gateway / subagent / coordinator) cannot forget one.
 *   - FROZEN: downstream phases consume the plan; they cannot amend it.
 *
 * The control layer creates ONE plan per run (`beginRun`) and threads it
 * through the run handle into `beginTurnAssembly`. The execution layer never
 * calls a resolver.
 */
import { createHash } from 'node:crypto';

import type { AgentProfile } from '@duya/agent-core';

import { resolveCacheSelection } from './cache-selection.js';
import type {
  AgentComposition,
  CacheSelectionInput,
  CompositionDecision,
  CompositionScope,
  CompositionSource,
  ModeSelection,
  PermissionSelection,
  PermissionSelectionInput,
  CacheSelection,
  PromptSelection,
  StartupComposition,
  ToolSelection,
  TurnOverrides,
} from './contract.js';
import { resolveModeSelection, type ModeModifierLookup } from './modes-selection.js';
import { resolvePermissionSelection } from './permissions-selection.js';
import { resolvePromptSelection } from './prompt-selection.js';
import {
  resolveTimeReminder,
  type TimeReminderBlockSelection,
  type TimeReminderSelectionInput,
} from './reminder-selection.js';
import { resolveCompositionScope } from './scope.js';
import { resolveSectionPlan } from './section-plan.js';
import { resolveToolSelection } from './tools-selection.js';

import type { ChatOptions } from '../worker-run-contracts.js';

/** The slice of `ChatOptions` the composition layer is allowed to interpret. */
export type TurnOverrideInput = Pick<
  ChatOptions,
  | 'systemPrompt'
  | 'disableSystemPrompt'
  | 'systemPromptPrefix'
  | 'outputStyleConfig'
  | 'researchIntent'
  | 'researchProjectId'
  | 'mode'
  | 'allowedTools'
  | 'disabledTools'
>;

const EMPTY_OVERRIDES: TurnOverrides = Object.freeze({ disableSystemPrompt: false });

/**
 * The ONLY place that turns a turn request into policy inputs.
 *
 * Renderers must not read `ChatOptions` for these fields: that would reopen a
 * second decision path. Values are copied by reference for structured fields
 * (they are inputs to `buildContext`, never mutated here) and the result is
 * frozen so a downstream phase cannot inject a field mid-turn.
 */
export function readTurnOverrides(options: TurnOverrideInput | undefined): TurnOverrides {
  if (!options) return EMPTY_OVERRIDES;
  const result: {
    -readonly [K in keyof TurnOverrides]: TurnOverrides[K];
  } = { disableSystemPrompt: options.disableSystemPrompt === true };
  if (options.systemPrompt !== undefined) result.systemPrompt = options.systemPrompt;
  if (options.systemPromptPrefix !== undefined) result.systemPromptPrefix = options.systemPromptPrefix;
  if (options.outputStyleConfig !== undefined) result.outputStyleConfig = options.outputStyleConfig;
  if (options.researchIntent !== undefined) result.researchIntent = options.researchIntent;
  if (options.researchProjectId !== undefined) result.researchProjectId = options.researchProjectId;
  if (options.mode !== undefined) result.mode = options.mode;
  if (options.allowedTools !== undefined) result.allowedTools = options.allowedTools;
  if (options.disabledTools !== undefined) result.disabledTools = options.disabledTools;
  return Object.freeze(result);
}

/** All facts a plan needs. Supplied by the caller; nothing is read from globals. */
export interface CompositionInput {
  readonly profile?: AgentProfile;
  readonly overrides?: TurnOverrides;
  readonly modeLookup?: ModeModifierLookup;
  readonly cache?: CacheSelectionInput;
  readonly permissions?: PermissionSelectionInput;
  /** Omit for runs that must not consume the reminder state (side questions). */
  readonly reminder?: TimeReminderSelectionInput | null;
  readonly environment?: {
    readonly sessionId?: string;
    readonly workingDirectory?: string | null;
  };
}

/** Session-startup facts, decided once before any profile is applied. */
export interface StartupCompositionInput {
  readonly cache: CacheSelectionInput;
  readonly permissionMode?: string;
}

function decision(
  field: string,
  value: string,
  source: CompositionSource,
  note?: string,
): CompositionDecision {
  return note === undefined
    ? { field, value, source }
    : { field, value, source, note };
}

/**
 * Freeze a resolver output recursively.
 *
 * Resolver outputs are freshly allocated (arrays are copied, decisions are
 * literals), so nothing here belongs to the caller. `TurnOverrides` is NOT
 * passed through this function: it holds caller-owned structured objects and
 * is only shallow-frozen in `readTurnOverrides`.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeDecisions(decisions: readonly CompositionDecision[]): readonly CompositionDecision[] {
  return deepFreeze(decisions);
}

function freezeSelection<T extends { readonly decisions: readonly CompositionDecision[] }>(
  selection: T,
): T {
  return deepFreeze({ ...selection });
}

function digestOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 16);
}

function scopeWithoutProfile(): {
  readonly scope: CompositionScope;
  readonly decisions: readonly CompositionDecision[];
} {
  return {
    scope: 'main-session',
    decisions: [
      decision('scope', 'main-session', 'host-default', 'no applied profile: the default composition'),
    ],
  };
}

function freezeReminders(
  reminders: TimeReminderBlockSelection | undefined,
): TimeReminderBlockSelection | undefined {
  if (!reminders) return undefined;
  return Object.freeze({
    ...reminders,
    ...(reminders.block ? { block: Object.freeze({ ...reminders.block }) } : {}),
    // `resolveTimeReminder` may return the caller's state object unchanged when
    // no emission happened. Copy before freezing so the session can still
    // replace its state on a later turn.
    state: Object.freeze({ ...reminders.state }),
    decisions: freezeDecisions(reminders.decisions),
  });
}

/**
 * Produce the frozen plan for one turn.
 *
 * The fingerprint deliberately EXCLUDES the reminder decision: a live clock
 * changes every turn, and including it would make an otherwise identical plan
 * look different in a rollout. Everything that affects prompt bytes, tools,
 * permissions and provider caching is included.
 */
export function composeAgent(input: CompositionInput = {}): AgentComposition {
  const overrides = input.overrides ?? EMPTY_OVERRIDES;
  const scope = input.profile
    ? resolveCompositionScope(input.profile)
    : scopeWithoutProfile();

  const prompt: PromptSelection = resolvePromptSelection(input.profile);
  const sections = resolveSectionPlan(input.profile);
  const tools: ToolSelection = resolveToolSelection(input.profile, {
    ...(overrides.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides.disabledTools !== undefined ? { disabledTools: overrides.disabledTools } : {}),
  });
  const modes: ModeSelection = resolveModeSelection(
    overrides.mode !== undefined ? { mode: overrides.mode } : {},
    input.modeLookup,
  );
  const permissions: PermissionSelection = resolvePermissionSelection(input.permissions ?? {});
  const cache: CacheSelection = resolveCacheSelection(input.cache ?? { protocol: 'other' });
  const reminders = freezeReminders(input.reminder ? resolveTimeReminder(input.reminder) : undefined);

  const injected = [
    overrides.systemPrompt !== undefined ? 'systemPrompt' : null,
    overrides.systemPromptPrefix !== undefined ? 'systemPromptPrefix' : null,
    overrides.outputStyleConfig !== undefined ? 'outputStyleConfig' : null,
    overrides.researchIntent !== undefined ? 'researchIntent' : null,
    overrides.researchProjectId !== undefined ? 'researchProjectId' : null,
  ].filter((name): name is string => name !== null);

  const decisions: readonly CompositionDecision[] = freezeDecisions([
    ...scope.decisions,
    ...prompt.decisions,
    ...sections.decisions,
    ...tools.decisions,
    ...modes.decisions,
    ...permissions.decisions,
    ...cache.decisions,
    ...(reminders?.decisions ?? []),
    decision(
      'composition.overrides',
      injected.length > 0 ? injected.join(',') : 'none',
      injected.length > 0 ? 'turn-override' : 'host-default',
      injected.length > 0
        ? 'names only: prompt bodies are never copied into the plan provenance'
        : 'no caller-supplied prompt injection this turn',
    ),
    decision(
      'composition.environment',
      input.environment?.sessionId ?? 'none',
      'config',
      input.environment?.workingDirectory ?? 'no working directory supplied',
    ),
  ]);

  const fingerprint = digestOf({
    scope: scope.scope,
    prompt,
    sections,
    tools,
    modes,
    permissions,
    cache,
    overrides,
    decisions,
  });

  const plan: AgentComposition = {
    scope: scope.scope,
    prompt: freezeSelection(prompt),
    sections,
    tools: freezeSelection(tools),
    modes: freezeSelection(modes),
    permissions: freezeSelection(permissions),
    cache: freezeSelection(cache),
    ...(reminders ? { reminders } : {}),
    overrides,
    decisions,
    fingerprint,
  };
  return Object.freeze(plan);
}

/** Produce the frozen startup plan used by the client and the permission setup. */
export function composeStartup(input: StartupCompositionInput): StartupComposition {
  const cache = resolveCacheSelection(input.cache);
  const permissions = resolvePermissionSelection(
    input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {},
  );
  const decisions = freezeDecisions([...cache.decisions, ...permissions.decisions]);
  const fingerprint = digestOf({ cache, permissions, decisions });
  return Object.freeze({
    cache: freezeSelection(cache),
    permissions: freezeSelection(permissions),
    decisions,
    fingerprint,
  });
}
