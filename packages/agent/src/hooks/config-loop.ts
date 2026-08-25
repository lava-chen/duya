/**
 * Config-driven loop hooks (plan 426 Phase 4): the bridge between the plan-87
 * `[hooks]` settings vocabulary and the loop-hook bus.
 *
 * For each of the three inject-capable loop events (PreTurn / PostToolUse /
 * PostTurn) that has configured matchers, emits ONE registration
 * (id `config.<event>`, priority 400 — after every builtin steering hook).
 * The handler builds a {@link BaseHookInput}, matches the event's matchers
 * (PostToolUse matchers filter on tool names via `matcher`), executes the
 * matched hooks sequentially, and folds every successful additionalContext
 * into a single `inject` effect with source `'custom'`.
 *
 * Fail-open contract: every hook failure is logged WARN and skipped; a
 * misconfigured hook never breaks the agent loop.
 *
 * All non-loop plan-87 events (SessionStart, SessionEnd, PreToolUse,
 * PostToolUseFailure, Stop, …) are dispatched by `ConfigHooksRunner`
 * (`./events.ts`) at their own call sites in `DuyaAgent.streamChat` — not
 * bridged here. PreFinalize remains unbridged (the bus has no veto path
 * for external hooks yet); when the factory sees it configured it logs one
 * WARN and skips.
 */

import type { LoopHookDispatchContext, LoopHookRegistration } from './loop.js';
import { readHooksConfig } from './config.js';
import { executeHook, executeHookBackground, hookCommandLine } from './executor.js';
import { hookCircuitBreaker, hookBreakerKey } from './circuit-breaker.js';
import type { BaseHookInput, HookMatcher, HookCommand, HooksSettings } from './types.js';
import {
  governHookContext,
  renderHookContextEnvelope,
  type HookContextInfo,
} from './injection.js';
import { logger } from '../utils/logger.js';

/** After every builtin steering hook (10/20/30) — user hooks steer last. */
const CONFIG_HOOK_PRIORITY = 400;

/** Loop events bridged onto the bus this phase (inject-capable only). */
const BRIDGED_EVENTS = ['PreTurn', 'PostToolUse', 'PostTurn'] as const;
type BridgedEvent = (typeof BRIDGED_EVENTS)[number];

export interface ConfiguredLoopHookDeps {
  /** Injected for tests; defaults to a fresh readHooksConfig() at factory time. */
  hooks?: HooksSettings;
  /** Working directory passed to command hooks; defaults to process.cwd(). */
  cwd?: string;
  /**
   * Run-level cap on total injected hook-context tokens across ALL bridged
   * events (PostToolUse fires every turn, so per-hook limits alone do not
   * bound cumulative volume). Default {@link RUN_INJECTION_BUDGET_TOKENS}.
   */
  runInjectionBudgetTokens?: number;
}

/** Default run-level cap on total hook-context injection (tokens). */
export const RUN_INJECTION_BUDGET_TOKENS = 50_000;

/** Shared spend tracker for one createConfiguredLoopHooks() call (= one run). */
interface InjectionBudget {
  cap: number;
  spent: number;
}

/**
 * Build loop-hook registrations from the plan-87 `[hooks]` settings. Returns
 * an empty array when nothing (or nothing valid) is configured.
 */
export function createConfiguredLoopHooks(deps?: ConfiguredLoopHookDeps): LoopHookRegistration[] {
  const settings = deps?.hooks !== undefined ? deps.hooks : readHooksConfig();
  if (!settings) return [];
  const cwd = deps?.cwd ?? process.cwd();
  const budget: InjectionBudget = {
    cap: deps?.runInjectionBudgetTokens ?? RUN_INJECTION_BUDGET_TOKENS,
    spent: 0,
  };

  const registrations: LoopHookRegistration[] = [];
  for (const event of BRIDGED_EVENTS) {
    const matchers = settings[event];
    if (!matchers || matchers.length === 0) continue;
    registrations.push(buildRegistration(event, matchers, cwd, budget));
  }

  // PreFinalize is the one configured event the loop bus dispatches that
  // this bridge deliberately does not cover (no veto path for external
  // hooks yet) — surface once. All other non-loop events are handled by
  // ConfigHooksRunner at their own call sites, so they are silent here.
  const prefinalize = settings.PreFinalize;
  if (prefinalize && prefinalize.length > 0) {
    logger.warn(
      `[ConfigHook] PreFinalize not dispatched on the loop bus yet (no external veto path; plan 87)`,
    );
  }
  return registrations;
}

function buildRegistration(
  event: BridgedEvent,
  matchers: HookMatcher[],
  cwd: string,
  budget: InjectionBudget,
): LoopHookRegistration {
  return {
    id: `config.${event}`,
    events: [event],
    priority: CONFIG_HOOK_PRIORITY,
    handler: async (ctx: LoopHookDispatchContext) => {
      const input = buildHookInput(event, ctx, cwd);
      const blocks: string[] = [];
      for (const matcher of matchers) {
        if (!matcherMatches(matcher, ctx, event)) continue;
        for (const hook of matcher.hooks) {
          // `async: true` command/process hooks launch in the background and
          // deliver their result via a mailbox notification when they settle
          // — the loop never blocks and there is no inject for them (the
          // turn they belong to may already be gone).
          if (hook.type === 'command' || hook.type === 'process') {
            if (hook.async === true) {
              // Same circuit breaker as the dispatcher: a broken async hook
              // stops being re-launched every turn after repeated failures.
              const key = hookBreakerKey(
                input.session_id ?? '',
                input.hook_event_name,
                hookCommandLine(hook),
              );
              const open = hookCircuitBreaker.describe(key);
              if (open !== null) {
                logger.warn(
                  `[ConfigHook] ${event} hook suppressed (circuit breaker open — ${open}): ${hookCommandLine(hook)}`,
                );
                continue;
              }
              const launched = executeHookBackground(hook, input, { cwd }, key);
              if (launched.ok) continue;
              logger.warn(
                `[ConfigHook] ${event} background hook failed to launch (skipped): ${launched.error}`,
              );
              continue;
            }
          }
          const result = await executeHook(hook, input, { cwd });
          const rawContext = collectHookContext(result, hook.type);
          if (!rawContext) {
            if (result.ok || result.exitCode !== undefined) continue;
            logger.warn(
              `[ConfigHook] ${event} ${hook.type} hook failed (skipped): ${result.error ?? 'unknown error'}`,
            );
            continue;
          }
          // Context-injection governance: budget → envelope. Each hook's
          // output is governed individually so one noisy hook cannot blow
          // the combined block past its own limit.
          const info: HookContextInfo = {
            event,
            hookName: hookCommandLine(hook),
            hookType: hook.type,
            seq: typeof (input as { turnCount?: number }).turnCount === 'number'
              ? (input as { turnCount: number }).turnCount
              : undefined,
          };
          const governed = governHookContext(rawContext, info, {
            limitTokens: (hook as { additionalContextLimit?: number }).additionalContextLimit,
            sessionId: input.session_id || undefined,
          });
          // Run-level aggregate budget: PostToolUse fires every turn, so
          // per-hook limits alone never bound cumulative volume. Once the
          // run budget is exhausted, further outputs degrade to a one-line
          // marker instead of silently disappearing (the model is told why).
          const remaining = budget.cap - budget.spent;
          if (governed.estimatedTokens > remaining) {
            logger.warn(
              `[ConfigHook] ${event} hook context omitted: run injection budget exhausted ` +
                `(${budget.spent}/${budget.cap} tokens)`,
            );
            blocks.push(renderHookContextEnvelope(
              info,
              `[hook output omitted: run hook-context budget exhausted (${budget.spent}/${budget.cap} tokens spent)]`,
            ));
            continue;
          }
          budget.spent += governed.estimatedTokens;
          blocks.push(renderHookContextEnvelope(info, governed.content));
        }
      }
      if (blocks.length === 0) return;
      return {
        type: 'inject' as const,
        injection: blocks.join('\n\n'),
        source: 'custom' as const,
        // Event-level replace-last key: a newer combined block replaces the
        // previous one in place; an unchanged block is deduped entirely.
        dedupKey: `config.${event}`,
      };
    },
  };
}

/**
 * Hook input for external executors: the BaseHookInput fields plus the event
 * name and turn counter (matches the PreTurn/PostTurn input schemas in
 * types.ts; PostToolUse is dispatched per turn here, not per tool call).
 */
function buildHookInput(
  event: BridgedEvent,
  ctx: LoopHookDispatchContext,
  cwd: string,
): BaseHookInput & { hook_event_name: BridgedEvent; turnCount: number } {
  return {
    session_id: ctx.sessionId ?? '',
    cwd,
    hook_event_name: event,
    turnCount: ctx.turnCount,
  };
}

/**
 * Whether a matcher applies to this dispatch. Only PostToolUse has a tool
 * surface to filter on: a `matcher` pattern matches when any tool call name
 * matches (regex; invalid regex falls back to substring). Matchers without a
 * `matcher` field match everything. A defensive `status` filter (not in the
 * current schema — zod strips it) matches per-call status markers the same
 * way if a future schema ever supplies them.
 */
function matcherMatches(
  matcher: HookMatcher,
  ctx: LoopHookDispatchContext,
  event: BridgedEvent,
): boolean {
  if (event !== 'PostToolUse') return true;
  const loose = matcher as HookMatcher & { status?: string };
  const toolCalls = ctx.toolCalls ?? [];

  if (loose.matcher !== undefined) {
    const matched = toolCalls.some((c) => patternMatches(loose.matcher!, c.name));
    if (!matched) return false;
  }
  if (loose.status !== undefined) {
    const statuses = toolCalls
      .map((c) => (c as { status?: unknown }).status)
      .filter((s): s is string => typeof s === 'string');
    if (!statuses.some((s) => patternMatches(loose.status!, s))) return false;
  }
  return true;
}

/** Regex match; an invalid pattern degrades to substring semantics. */
function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return value.includes(pattern);
  }
}

/**
 * Extract the injectable text from one execution result: success carries
 * `additionalContext`; verifier semantics feed a non-zero exit's diagnostic
 * back instead of swallowing it (the whole point of a post-edit verifier).
 * True infra failures (spawn failure, timeout) carry no `exitCode` and stay
 * silent (fail-open). Returns null when there is nothing to inject.
 */
function collectHookContext(
  result: Awaited<ReturnType<typeof executeHook>>,
  hookType: HookCommand['type'],
): string | null {
  if (result.ok) return result.additionalContext ?? null;
  if (result.exitCode !== undefined) {
    return result.error ? `[verify:${hookType}] ${result.error}` : null;
  }
  return null;
}
