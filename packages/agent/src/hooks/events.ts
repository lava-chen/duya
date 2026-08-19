/**
 * Config-driven event hook runner (plan 426 follow-up).
 *
 * The loop bus (`./loop.ts`) carries the four agent-loop events
 * (PreTurn / PostToolUse / PreFinalize / PostTurn). This runner dispatches
 * the remaining plan-87 events — SessionStart, SessionEnd, UserPromptSubmit,
 * PreToolUse, PostToolUseFailure, Stop, SubagentStart/Stop, TaskCreated/
 * Completed, PermissionDenied, … — which are command/notification hooks:
 * they run to completion and their stdout / verifier diagnostics are
 * collected as `additionalContext` for the caller (fail-open: a broken
 * hook logs WARN and is skipped, never breaking the agent).
 *
 * Synchronous blocking semantics by default: every matched hook awaits
 * completion in configured array order before the next runs. `async: true`
 * command/process hooks (non-decision events only) instead launch in the
 * background and return immediately — their result arrives later via a
 * mailbox background_notification (see ./notify.ts), never blocking the
 * agent loop.
 */

import { readHooksConfig } from './config.js';
import {
  executeHook,
  type HookExecutionResult,
} from './executor.js';
import type { BaseHookInput, HookCommand, HookEvent, HookMatcher, HooksSettings } from './types.js';
import { logger } from '../utils/logger.js';

export interface ConfigHooksRunnerOptions {
  /**
   * Injected for tests; defaults to a fresh readHooksConfig() at
   * construction time.
   */
  settings?: HooksSettings;
  /** Working directory passed to command/process hooks. */
  cwd?: string;
  /** `${KEY}` expansion values for `process` hooks (command + args). */
  vars?: Record<string, string>;
}

export interface EventHookRunResult {
  /** Number of hooks that matched and ran. */
  executed: number;
  /**
   * additionalContext lines: successful hook stdout, plus verifier
   * diagnostics (`[verify:<type>] …`) from non-zero exits — never infra
   * failure text (those stay silent, fail-open).
   */
  contexts: string[];
  /** Background (async: true) hook task ids launched this dispatch. */
  backgroundTasks: string[];
}

/**
 * Hook input accepted by the runner: the shared BaseHookInput fields plus
 * the event name and any event-specific fields (tool_name, prompt, reason,
 * … — each plan-87 event schema extends BaseHookInput with
 * `hook_event_name` plus its own fields; the subprocess receives the whole
 * object serialized on stdin).
 */
export type EventHookInput = BaseHookInput & { hook_event_name: string } & Record<string, unknown>;

/** Matcher targets available for tool-scoped events (PreToolUse et al.). */
export interface EventHookMatcherTargets {
  /** Tool name to match `matcher` patterns against. */
  toolName?: string;
}

/**
 * Events whose semantics are a decision gate: the agent must see the hook
 * result before proceeding, so `async: true` is meaningless — it is
 * downgraded to sync with a WARN.
 */
const DECISION_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(['PreToolUse']);

export class ConfigHooksRunner {
  private readonly settings: HooksSettings | undefined;
  private readonly cwd: string;
  private readonly vars: Record<string, string>;

  constructor(opts: ConfigHooksRunnerOptions = {}) {
    this.settings = opts.settings !== undefined ? opts.settings : readHooksConfig();
    this.cwd = opts.cwd ?? process.cwd();
    this.vars = opts.vars ?? {};
  }

  /**
   * Dispatch one event. Matchers run in configured array order; within a
   * matched matcher, hooks run sequentially. Sync hooks block the chain
   * (await completion); `async: true` command/process hooks launch in the
   * background and return immediately — their result arrives later via a
   * mailbox notification, like any background bash task. Decision events
   * (PreToolUse) ignore `async` (WARN + downgrade). Throwing / failing
   * hooks are skipped with a WARN. Returns what ran and what to surface
   * back.
   */
  async run(
    event: HookEvent,
    input: EventHookInput,
    targets?: EventHookMatcherTargets,
  ): Promise<EventHookRunResult> {
    const matchers = this.settings?.[event];
    if (!matchers || matchers.length === 0) {
      return { executed: 0, contexts: [], backgroundTasks: [] };
    }

    const contexts: string[] = [];
    const backgroundTasks: string[] = [];
    let executed = 0;
    for (const matcher of matchers) {
      if (!matcherApplies(matcher, targets)) continue;
      for (const hook of matcher.hooks) {
        executed++;
        try {
          const result = await executeHookSafe(hook, input, event, {
            cwd: this.cwd,
            vars: this.vars,
            backgroundTasks,
          });
          if (result.ok) {
            if (result.additionalContext) contexts.push(result.additionalContext);
            continue;
          }
          // Verifier semantics: a command/process hook that ran but exited
          // non-zero reported problems (lint, typecheck). Feed its
          // diagnostic back instead of swallowing it. True infra failures
          // (spawn failure, timeout) carry no `exitCode` and stay silent.
          if (result.exitCode !== undefined) {
            if (result.error) contexts.push(`[verify:${hook.type}] ${result.error}`);
            continue;
          }
          logger.warn(
            `[Hooks] ${event} ${hook.type} hook failed (skipped): ${result.error ?? 'unknown error'}`,
          );
        } catch (err) {
          logger.warn(
            `[Hooks] ${event} ${hook.type} hook threw (skipped): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { executed, contexts, backgroundTasks };
  }
}

/**
 * Run one hook. Async-capable command/process hooks on non-decision events
 * launch in the background via executeHook (recorded in backgroundTasks,
 * no blocking); decision events downgrade async to sync with a WARN.
 */
async function executeHookSafe(
  hook: HookCommand,
  input: EventHookInput,
  event: HookEvent,
  opts: {
    cwd: string;
    vars: Record<string, string>;
    backgroundTasks: string[];
  },
): Promise<HookExecutionResult> {
  let effective = hook;
  if ((hook.type === 'command' || hook.type === 'process') && hook.async === true) {
    if (DECISION_EVENTS.has(event)) {
      logger.warn(
        `[Hooks] ${event} is a decision event — async ignored, running ${hook.type} hook synchronously`,
      );
      effective = { ...hook, async: false };
    }
  }
  const result = await executeHook(effective, input, opts);
  if (result.backgroundTaskId) opts.backgroundTasks.push(result.backgroundTaskId);
  return result;
}

/**
 * Whether a matcher applies to this dispatch. A `matcher` pattern is
 * matched against the target tool name (regex; an invalid regex degrades
 * to substring). Matchers without a `matcher` field match everything.
 */
function matcherApplies(matcher: HookMatcher, targets?: EventHookMatcherTargets): boolean {
  if (matcher.matcher === undefined) return true;
  const value = targets?.toolName;
  if (value === undefined) return true;
  return patternMatches(matcher.matcher, value);
}

/** Regex match; an invalid pattern degrades to substring semantics. */
function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return value.includes(pattern);
  }
}
