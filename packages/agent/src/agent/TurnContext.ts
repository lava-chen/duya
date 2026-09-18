/**
 * TurnContext — Plan 550 step 2a.
 *
 * `duyaAgent.streamChat` is currently 2200+ lines and tracks 60+ private
 * fields just to assemble one turn. This file introduces the
 * `TurnContext` value type that will eventually absorb that
 * per-turn-local state into a single object the `TurnAssembler` can
 * hand to the loop body.
 *
 * The shape and contract of `TurnContext` are landing **first** so the
 * `TurnAssembler` class can be wired up incrementally — every field
 * has an explicit name and tests pin the assembly rules. The wiring
 * into `duyaAgent.streamChat` is a follow-up commit; until that lands,
 * `TurnContext` is unused at runtime, only validated by its tests.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { LocalToolPermission } from '../permissions/types.js';
import type { PermissionMode } from '../permissions/types.js';
import type { CommunicationPlatform } from '../prompts/types.js';

/**
 * Identifier for a single turn. The agent runs in a session; each
 * `streamChat` call increments the per-session turn counter.
 */
export interface TurnId {
  /** Per-session turn number, monotonically increasing. */
  readonly sequence: number;
  /** Stable id used in journal + SSE events. */
  readonly id: string;
}

/**
 * Mention injection payloads collected at the start of a turn:
 * providers / skills / plugins the user `@`-mentioned in the prompt.
 * Each block becomes a transient system-reminder on the first model
 * turn.
 *
 * Why a value object: these are set in `streamChat` from the
 * `MentionResolver`, then drained into `promptContexts`. Bundling them
 * into `TurnContext` keeps the `TurnAssembler` from having to call
 * three separate setters.
 */
export interface MentionInjections {
  readonly provider?: string;
  readonly skills: readonly string[];
  readonly plugins: readonly string[];
  /** Already-resolved render blocks; the assembler hands them straight to the model. */
  readonly contexts: readonly string[];
}

/**
 * Per-turn approval + always-allow grants. Reset on every `streamChat`
 * call so a follow-up turn does not leak rules from the previous turn.
 */
export interface ApprovalLedger {
  /** Optional callback to consume one pre-approved card. */
  readonly consumeApprovedEffect?: () => void;
  /** Set of tool names the user pre-approved for this turn only. */
  readonly alwaysAllowTools: ReadonlySet<string>;
}

/**
 * A self-contained description of everything the agent loop needs to
 * run one turn. `TurnAssembler.build(duyaAgent, options)` is the only
 * constructor in this commit's vicinity; once 2a-2e land, this object
 * flows through the rest of the agent loop in place of the current
 * 60-field spread.
 */
export interface TurnContextShape {
  readonly turnId: TurnId | null;
  readonly sessionId: string | null;
  readonly workingDirectory: string | null;
  readonly communicationPlatform?: CommunicationPlatform;
  readonly language?: string;
  readonly permissionMode: PermissionMode;
  readonly hostToolPermission?: LocalToolPermission;
  readonly additionalWorkingDirectories: ReadonlyMap<string, unknown>;
  readonly approval: ApprovalLedger;
  readonly mentions: MentionInjections;
  /** Raw prompt text (after flattening MessageContent arrays). */
  readonly promptText: string;
}

/**
 * Frozen implementation of `TurnContextShape`. The assembler returns
 * one of these from `build()`; downstream code should treat every
 * field as immutable so the per-turn local state stays contained even
 * once the assembler hands the context off to other modules.
 */
export class TurnContext implements TurnContextShape {
  readonly turnId: TurnId | null;
  readonly sessionId: string | null;
  readonly workingDirectory: string | null;
  readonly communicationPlatform: CommunicationPlatform | undefined;
  readonly language: string | undefined;
  readonly permissionMode: PermissionMode;
  readonly hostToolPermission: LocalToolPermission | undefined;
  readonly additionalWorkingDirectories: ReadonlyMap<string, unknown>;
  readonly approval: ApprovalLedger;
  readonly mentions: MentionInjections;
  readonly promptText: string;

  constructor(shape: TurnContextShape) {
    this.turnId = shape.turnId;
    this.sessionId = shape.sessionId;
    this.workingDirectory = shape.workingDirectory;
    this.communicationPlatform = shape.communicationPlatform;
    this.language = shape.language;
    this.permissionMode = shape.permissionMode;
    this.hostToolPermission = shape.hostToolPermission;
    this.additionalWorkingDirectories = shape.additionalWorkingDirectories;
    this.approval = shape.approval;
    this.mentions = shape.mentions;
    this.promptText = shape.promptText;
    Object.freeze(this);
  }
}

/**
 * Empty / default `MentionInjections`. The assembler deep-merges any
 * mention payloads resolved at the start of the turn onto this base.
 */
export const NO_MENTIONS: Readonly<MentionInjections> = Object.freeze({
  skills: [],
  plugins: [],
  contexts: [],
});

/**
 * Empty / default `ApprovalLedger`. Matches the legacy
 * `duyaAgent` initial values before the per-turn `streamChat`
 * overrides land.
 */
export const NO_APPROVAL_LEDGER: Readonly<ApprovalLedger> = Object.freeze({
  alwaysAllowTools: new Set<string>(),
});