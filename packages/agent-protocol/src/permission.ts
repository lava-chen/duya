/**
 * Permission vocabulary: one set of actions, one clock, one audit chain.
 *
 * ## Why this file is not a type shim
 *
 * The current codebase has THREE incompatible vocabularies for the same
 * decision:
 *
 *   callback return   'allow' | 'deny' | 'paused'          (agent/src/types.ts:337)
 *   HTTP receive      allow | deny | allow_once | allow_for_session   (router.ts:1785)
 *   worker receive    same four                           (agent-process-entry.ts:4413)
 *
 * `'paused'` is not a permission outcome at all — it is what the bot approval
 * card path actually means when a host never answers (types.ts:334-336). And
 * `expiresAt` exists on two independent clocks: the agent mints the value, the
 * worker sets the timer.
 *
 * pi-protocol's schemas.ts has the comment "Matches AgentHarnessPhase so
 * adapters do not need a second phase vocabulary". That is the entire reason
 * this file exists: ONE vocabulary, derived where possible, policed by drift
 * test #7.
 */

/** The four legal outcomes. There is no fifth. */
export const PERMISSION_ACTIONS = ['allow', 'allow_always', 'deny', 'defer'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

const PERMISSION_ACTION_SET: ReadonlySet<string> = new Set<string>(PERMISSION_ACTIONS);
export function isPermissionAction(value: string): value is PermissionAction {
  return PERMISSION_ACTION_SET.has(value);
}

export type PermissionScope =
  | { readonly kind: 'tool'; readonly toolName: string }
  | { readonly kind: 'session' }
  | { readonly kind: 'rule'; readonly ruleContent: string };

export type PermissionDecision =
  | {
      readonly action: 'allow';
      /** Host may rewrite tool input; `userModified` records that it did. */
      readonly updatedInput?: Readonly<Record<string, unknown>>;
      readonly userModified?: boolean;
    }
  | { readonly action: 'allow_always'; readonly scope: PermissionScope }
  | { readonly action: 'deny'; readonly reason?: string }
  | { readonly action: 'defer' };

/** Returned by `respondToPermission`. NOT an error path.
 *  A late answer is normal when a host was offline. */
export type PermissionAck =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason:
        | 'permission_expired'
        | 'permission_unknown_request'
        | 'run_terminal'
        | 'not_permission_action';
    };

/** Who answered. Persisted so an audit can distinguish policy from operator. */
export type PermissionSource = 'host' | 'policy' | 'default' | 'timeout' | 'cancelled';

export type PermissionMode =
  | 'generic'
  | 'ask_user_question'
  | 'exit_plan_mode';

export type PermissionKind =
  | 'tool_use'
  | 'read_path'
  | 'write_path'
  | 'execute'
  | 'network'
  | 'mcp_tool'
  | 'connector'
  | string;

// ── Events ────────────────────────────────────────────────────────────────

export interface PermissionRequested {
  readonly requestId: string;
  readonly kind: PermissionKind;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly mode: PermissionMode;
  readonly reason?: string;
  readonly suggestions?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly blockedPath?: string;
  /**
   * SINGLE AUTHORITATIVE CLOCK:
   *   expiresAt = startedAt + manifest.permissionPolicy.defaultTimeoutMs
   * defaultTimeoutMs defaults to 300_000, matching the hardcoded value at
   * agent-process-entry.ts:2240. The legacy `PermissionRequestEvent.expiresAt`
   * was minted by the agent while the timer was set by the worker — two clocks
   * that could disagree. Here one value is minted in one place.
   */
  readonly expiresAt: number;
}

export interface PermissionResolved {
  readonly requestId: string;
  readonly action: PermissionAction;
  readonly source: PermissionSource;
  readonly latencyMs: number;
  readonly scope?: PermissionScope;
  readonly reason?: string;
}

export interface PermissionExpired {
  readonly requestId: string;
  readonly afterMs: number;
}

// ── Legacy mapping ──────────────────────────────────────────────

/**
 * Legacy verb → protocol action. Delete one release after 07 M5 lands.
 *
 * `allow_for_session` is process-scoped in practice today
 * (agent-process-entry.ts:4414-4416) ONLY because one worker happens to serve
 * one session. The protocol's `allow_always { scope: session }` must NOT
 * inherit that coincidence — that inheritance is exactly how a "session"
 * grant silently becomes a process grant the first time a worker is reused.
 */
export const LEGACY_ACTION_MAP: Readonly<Record<string, PermissionAction>> = {
  allow: 'allow',
  allow_once: 'allow',
  allow_for_session: 'allow_always',
  deny: 'deny',
  paused: 'deny',
};

/**
 * Normalise a legacy verb. `'paused'` maps to `deny` because that is the
 * observable meaning of the bot approval card path (types.ts:334-336): the
 * host never answered, so the request timed out. Anything unrecognised becomes
 * `defer` plus a diagnostic rather than a guessed allow.
 */
export function normalizeLegacyAction(legacy: string): PermissionDecision {
  const mapped = LEGACY_ACTION_MAP[legacy];
  if (mapped === 'allow') return { action: 'allow' };
  if (mapped === 'allow_always') return { action: 'allow_always', scope: { kind: 'session' } };
  if (mapped === 'deny') return { action: 'deny' };
  return { action: 'defer' };
}
