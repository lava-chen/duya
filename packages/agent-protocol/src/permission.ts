/**
 * Permission vocabulary: one set of actions, one clock, one audit chain.
 *
 * ## The chain
 *
 *   run policy            this run's rules, fixed at start (manifest.permissionPolicy)
 *        |
 *   evaluation            runtime-internal policy engine: allow / ask / deny
 *        | ask
 *   PermissionRequest      what the host is asked about
 *        |
 *   PermissionResponse     what the host or user answered
 *        |
 *   PermissionResolution   the durable fact, emitted as permission.resolved
 *
 * Only the last three are on the wire. The evaluation is deliberately absent:
 * it is runtime-internal, has no wire representation, and an adapter has no
 * business reproducing a policy engine.
 *
 * ## Why the four names rather than three
 *
 * The old system already used `PermissionDecision` for the EVALUATION — the
 * `{ behavior: 'allow' | 'ask' | 'deny' }` a policy engine returns, before
 * anyone is asked. Naming the host's answer `PermissionDecision` as well would
 * put two different things under one identifier in exactly the files that get
 * migrated, and the compiler cannot tell them apart once both are in scope.
 * So the name stays with the concept that already had it, and the wire types
 * are named for what they carry.
 *
 * `PermissionPolicyMode` and `PermissionRequestMode` are split for the same
 * reason. They are different layers: one is how the whole run is configured,
 * the other is which interactive situation a single request belongs to.
 *
 * ## The legacy vocabulary, and why none of it survives
 *
 * The current codebase has three incompatible vocabularies for the same
 * decision:
 *
 *   callback return   'allow' | 'deny' | 'paused'
 *   HTTP receive      allow | deny | allow_once | allow_for_session
 *   worker receive    same four
 *
 * `'paused'` is not a permission outcome at all — it is what the bot approval
 * card path means when a host never answers. `allow_once` restates what a
 * plain allow already says. And `allow_for_session` encodes a duration inside
 * an action name, so the protocol splits duration out into `scope` instead.
 * pi-protocol's schemas.ts has the comment "Matches AgentHarnessPhase so
 * adapters do not need a second phase vocabulary" — that is the whole point
 * here: one vocabulary, policed by drift test #7.
 */

/**
 * The four legal outcomes. There is no fifth.
 *
 * `allow` is always scoped to the one request that asked. Anything longer
 * lived is `allow_always` plus an explicit `PermissionScope`, so duration is
 * never encoded in the action name.
 */
export const PERMISSION_ACTIONS = ['allow', 'allow_always', 'deny', 'defer'] as const;

/** One of the four legal outcomes of a permission request. */
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

const PERMISSION_ACTION_SET: ReadonlySet<string> = new Set<string>(PERMISSION_ACTIONS);

/**
 * Type guard for a permission action.
 *
 * @param value - Candidate action string, typically from an untrusted wire frame.
 * @returns The narrowed action, or `undefined` when it is not one of the four.
 */
export function isPermissionAction(value: string): value is PermissionAction {
  return PERMISSION_ACTION_SET.has(value);
}

/** How long a grant survives. Absent on `PermissionResponse` for one-shot answers. */
export type PermissionScope =
  | { readonly kind: 'tool'; readonly toolName: string }
  | { readonly kind: 'session' }
  | { readonly kind: 'rule'; readonly ruleContent: string };

/**
 * A host's or user's answer to a `PermissionRequest`.
 *
 * Named for what it carries rather than reusing `PermissionDecision`, which
 * already means the policy engine's verdict in the system being migrated.
 *
 * @see PermissionRequest
 * @see PermissionResolution
 */
export type PermissionResponse =
  | {
      readonly action: 'allow';
      /** Host may rewrite tool input; `userModified` records that it did. */
      readonly updatedInput?: Readonly<Record<string, unknown>>;
      readonly userModified?: boolean;
    }
  | { readonly action: 'allow_always'; readonly scope: PermissionScope }
  | { readonly action: 'deny'; readonly reason?: string }
  | { readonly action: 'defer' };

/**
 * Returned by `respondToPermission`. Not an error path — a late answer is
 * normal when a host was offline, and the rejection says which of the three
 * unanswerable situations it hit.
 */
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

/** Who decided. Persisted so an audit can distinguish policy from operator. */
export type PermissionSource = 'host' | 'policy' | 'default' | 'timeout' | 'cancelled';

/**
 * Which interactive situation a single request belongs to.
 *
 * Not the same thing as `PermissionPolicyMode`, which configures the whole
 * run. A run in `plan` mode can still raise a `generic` request.
 */
export type PermissionRequestMode =
  | 'generic'
  | 'ask_user_question'
  | 'exit_plan_mode';

/** What is being asked about. Open-ended so a runtime can add kinds. */
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

/**
 * A question put to the host, emitted as `permission.requested`.
 *
 * @see PermissionResponse
 * @see PermissionResolution
 */
export interface PermissionRequest {
  readonly requestId: string;
  /**
   * PRODUCER FACT. The runtime's permission engine classified this request; the
   * adapter did not.
   *
   * An adapter that infers `kind` from `toolName` and emits the result as if it
   * were classified is producing a guess that then reads as a fact in the
   * durable audit chain. There is no legitimate derivation: `Read` is both
   * `read_path` and, for some arguments, a `connector`. If the runtime cannot
   * classify a request, the honest move is to emit `generic` deliberately and
   * say so, not to infer and pass.
   */
  readonly kind: PermissionKind;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /**
   * PRODUCER FACT, for the same reason as `kind`: which interactive situation
   * raised this. Deriving it from the run's `PermissionPolicyMode` is wrong —
   * a run in `plan` mode still raises `generic` requests.
   */
  readonly mode: PermissionRequestMode;
  readonly reason?: string;
  readonly suggestions?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly blockedPath?: string;
  /** When the runtime raised the request. Paired with `expiresAt` below. */
  readonly startedAt: number;
  /**
   * The single authoritative clock, owned by the Runtime's permission
   * coordinator: `expiresAt = startedAt + manifest.permissionPolicy.defaultTimeoutMs`.
   *
   * One number, minted in one place, enforced by the same component. The
   * legacy shape let the agent mint `expiresAt` while the worker set the timer,
   * so the deadline a host displayed and the deadline a worker enforced were
   * two values that could disagree.
   *
   * A runtime WITHOUT a coordinator must not emit this field with an invented
   * value. It advertises `run.permissionExpiryClock: 'absent'` and withholds
   * `permission.expired`, which is gated on the `permission_expiry` host
   * capability so a host is never told about a deadline nobody enforces.
   */
  readonly expiresAt: number;
}

/**
 * The durable fact about how a request ended, emitted as `permission.resolved`.
 *
 * Emitted for every request exactly once, including the timeout path — a
 * `PermissionExpired` precedes a resolution with `deny` and `source: 'timeout'`
 * so a reconnecting host can reconstruct that a deadline passed instead of
 * inferring it from a deny.
 */
export interface PermissionResolution {
  readonly requestId: string;
  readonly action: PermissionAction;
  readonly source: PermissionSource;
  readonly latencyMs: number;
  readonly scope?: PermissionScope;
  readonly reason?: string;
}

/** Emitted when a request passes `expiresAt` unanswered. Always followed by a `PermissionResolution`. */
export interface PermissionExpired {
  readonly requestId: string;
  readonly afterMs: number;
}

// ── Legacy mapping ────────────────────────────────────────────────────────

/**
 * Legacy verb to protocol action.
 *
 * `allow_for_session` is process-scoped in practice today only because one
 * worker happens to serve one session. The protocol's `allow_always` with a
 * `session` scope must NOT inherit that coincidence — inheriting it is exactly
 * how a session grant silently becomes a process grant the first time a worker
 * is reused.
 *
 * @deprecated Removed together with the rest of the legacy bridge.
 */
export const LEGACY_ACTION_MAP: Readonly<Record<string, PermissionAction>> = {
  allow: 'allow',
  allow_once: 'allow',
  allow_for_session: 'allow_always',
  deny: 'deny',
  paused: 'deny',
};

/**
 * Normalise a legacy verb to a `PermissionResponse`.
 *
 * `'paused'` maps to `deny` because that is its observable meaning on the bot
 * approval card path: the host never answered, so the request timed out.
 * Anything unrecognised becomes `defer` rather than a guessed allow.
 *
 * @param legacy - Verb from the pre-protocol wire vocabulary.
 * @returns A response carrying the corresponding action.
 * @deprecated Part of the legacy bridge; removed after the router cutover.
 */
export function normalizeLegacyAction(legacy: string): PermissionResponse {
  const mapped = LEGACY_ACTION_MAP[legacy];
  if (mapped === 'allow') return { action: 'allow' };
  if (mapped === 'allow_always') return { action: 'allow_always', scope: { kind: 'session' } };
  if (mapped === 'deny') return { action: 'deny' };
  return { action: 'defer' };
}
