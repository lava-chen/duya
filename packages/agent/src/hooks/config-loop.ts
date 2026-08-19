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
}

/**
 * Build loop-hook registrations from the plan-87 `[hooks]` settings. Returns
 * an empty array when nothing (or nothing valid) is configured.
 */
export function createConfiguredLoopHooks(deps?: ConfiguredLoopHookDeps): LoopHookRegistration[] {
  const settings = deps?.hooks !== undefined ? deps.hooks : readHooksConfig();
  if (!settings) return [];
  const cwd = deps?.cwd ?? process.cwd();

  const registrations: LoopHookRegistration[] = [];
  for (const event of BRIDGED_EVENTS) {
    const matchers = settings[event];
    if (!matchers || matchers.length === 0) continue;
    registrations.push(buildRegistration(event, matchers, cwd));
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
): LoopHookRegistration {
  return {
    id: `config.${event}`,
    events: [event],
    priority: CONFIG_HOOK_PRIORITY,
    handler: async (ctx: LoopHookDispatchContext) => {
      const input = buildHookInput(event, ctx, cwd);
      const contexts: string[] = [];
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
          if (result.ok) {
            if (result.additionalContext) contexts.push(result.additionalContext);
            continue;
          }
          // Verifier semantics: a command hook that ran but exited non-zero
          // reported problems (e.g. lint/typecheck failures). Feed its
          // diagnostic back to the model instead of swallowing it — the
          // whole point of a post-edit verifier. True infra failures (spawn
          // failure, timeout) carry no `exitCode` and stay silent (fail-open).
          if (result.exitCode !== undefined) {
            if (result.error) contexts.push(`[verify:${hook.type}] ${result.error}`);
            continue;
          }
          logger.warn(
            `[ConfigHook] ${event} ${hook.type} hook failed (skipped): ${result.error ?? 'unknown error'}`,
          );
        }
      }
      if (contexts.length === 0) return;
      return { type: 'inject', injection: contexts.join('\n\n'), source: 'custom' };
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
