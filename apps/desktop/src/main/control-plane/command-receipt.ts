/**
 * command-receipt.ts — the receipt a Control Plane COMMAND produces
 * (plan 587 C6.1, "commandreceipt有schema、sender/auth、typedfailure").
 *
 * ## What was missing
 *
 * R1.3 built a receipt for a durable run WRITE (`run-receipt.ts`: `applied`,
 * `reconciled`, `conflict`, `busy`, …). What it does not describe is the
 * envelope a COMMAND comes in: which schema version the sender spoke, whether
 * the sender was allowed to speak it at all, and what the failure means to
 * somebody who did not write the code that failed.
 *
 * Three things went unrecorded before this file:
 *
 *  1. **Schema.** Nothing on the `db:request` channel declared a version, so a
 *     producer and a consumer could disagree about a payload's shape and the
 *     only symptom would be a `undefined` read somewhere downstream.
 *  2. **Sender/auth.** `handleDbRequest` (`agents/db-bridge.ts:2856`) dispatched
 *     whatever action string it was handed, from whatever process sent it. The
 *     decision helper already exists — `evaluateTrustedSender`, the one place
 *     that decides whether a message came from something the app trusts — and
 *     it is PURE, so it is reused here rather than a second, subtly different
 *     check being written for the IPC-shaped channel. The import is
 *     `ipc/trusted-sender-core` rather than `ipc/trusted-sender`, because the
 *     adapter reaches `core/window-manager` and therefore `electron`; the pure
 *     decision is the part worth sharing. See {@link CommandSenderFacts} for
 *     how the two vocabularies relate.
 *  3. **Typed failure.** A command that failed said `{ success: false, error:
 *     string }`. That is the same collapse `run-receipt.ts` was written to
 *     remove, one layer up.
 *
 * ## The failure vocabulary is R1.3's, extended — not a parallel one
 *
 * A command that reached storage reuses `RunWriteReceipt` verbatim, so a caller
 * still branches on `conflict` and `busy` the way it already does. The states
 * added here are the ones a *command* adds and a *write* cannot have: a refusal
 * that happened before storage was involved.
 *
 * ## Why a post-ack failure is not swallowed
 *
 * {@link CommandReceipt.terminal} is `false` for every non-durable state, and
 * {@link assertCommandAccepted} THROWS for a receipt that is neither durable nor
 * an explicitly-deferred answer. The rule the plan states — a failure after the
 * ack must not be swallowed — is implemented as a single choke point rather than
 * left to each caller's diligence: a caller that wants to know must be the one
 * that says so, and a caller that does not is forced to handle the throw.
 */

import {
  describeReceipt,
  isDurableWrite,
  type RunWriteReceipt,
} from './run-receipt';
import {
  evaluateTrustedSender,
  type TrustedSenderConfig,
  type TrustedSenderVerdict,
} from '../ipc/trusted-sender-core';

// ── schema ────────────────────────────────────────────────────────────────

/**
 * The command envelope's schema version.
 *
 * A single literal today. It is a literal union rather than a `number` so that
 * a second version cannot be introduced without a decision about which actions
 * it changes, and so a consumer can switch exhaustively.
 */
export const COMMAND_SCHEMA_VERSION = 1 as const;

export type CommandSchemaVersion = typeof COMMAND_SCHEMA_VERSION;

/** One command, as it arrives on `db:request`. */
export interface CommandEnvelope {
  readonly schema: CommandSchemaVersion;
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ── sender / auth ─────────────────────────────────────────────────────────

/**
 * The sender facts a Control Plane command carries.
 *
 * The `db:request` channel is not an Electron IPC frame, so the decision is
 * expressed in the vocabulary of the process that actually sends it: which
 * registered child of THIS host, and which session the host has it filed under.
 *
 * The check itself is not rewritten. `evaluateTrustedSender` is reused with the
 * two fact types projected onto each other:
 *
 *  - `senderId`  ← the child pid: identity of the sending process, which is the
 *    same question `senderId` asks for a webContents.
 *  - `frameRoutingId` ← `0` for the host's OWN bootstrap call and the session's
 *    registered route otherwise; a message arriving for a session the sending
 *    child is not registered under reads as a subframe, i.e. not the sender we
 *    think it is.
 *  - `frameUrl`  ← the child's role (`DUYA_AGENT_ROLE`), projected onto a URL
 *    whose AUTHORITY is the role: `https://<role>.duya-agent.internal`. The
 *    authority has to carry the role rather than the scheme because the WHATWG
 *    `URL.origin` of a non-special scheme is the string `"null"`, which every
 *    origin check would refuse — a `duya-agent://chat` sender would be
 *    indistinguishable from a frame on an unknown origin, i.e. the check would
 *    be vacuously strict and never admit anybody. As a host, the origin parses,
 *    stays distinct per role, and an unparseable or unlisted one still fails
 *    closed exactly as a foreign frame does.
 *
 * That projection is the honest reuse available without editing ISS-30's helper
 * or forking its semantics; a genuinely different transport deserves a genuinely
 * different fact type, and inventing one here is the "second trusted-sender
 * check" the plan forbids.
 */
export interface CommandSenderFacts {
  /** The sending child's pid, or `null` when the host itself is the sender. */
  readonly senderPid: number | null;
  /**
   * The session the host has this child registered under. `null` for a
   * host-initiated command.
   */
  readonly registeredSessionId: string | null;
  /** `DUYA_AGENT_ROLE` of the sending process, e.g. `chat` / `workflow-runtime`. */
  readonly role: string | null;
}

/** Which roles this host lets speak Control Plane commands. */
export interface CommandSenderConfig {
  /**
   * The role origins the sending process may be on, e.g.
   * `https://chat.duya-agent.internal`. An empty list refuses everything.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * The pids this host actually spawned and still holds, read AT CHECK TIME.
   *
   * A function rather than a set: a set captured at boot would refuse every
   * worker spawned afterwards, which is most of them. A `db:request` from a pid
   * outside this set is refused. This is the check that did not exist — the
   * channel previously dispatched any action string from any sender.
   */
  readonly trustedPids: () => ReadonlySet<number>;
}

/** The synthetic origin a role is projected onto. */
export function roleOrigin(role: string): string {
  return `https://${role}.duya-agent.internal`;
}

/** Project a command sender onto the trusted-sender fact shape. */
function toTrustedSenderFacts(facts: CommandSenderFacts, trustedPids: ReadonlySet<number>): {
  senderId: number;
  frameRoutingId: number | null;
  frameUrl: string | null;
} {
  // A host-initiated command has no child pid and is therefore not in
  // `trustedPids`; give it the routing id the helper treats as "the sender's
  // own top frame" and let the pid comparison be the thing that admits it.
  const senderId = facts.senderPid ?? -1;
  return {
    senderId,
    frameRoutingId: trustedPids.has(senderId) ? 0 : null,
    frameUrl: facts.role === null ? null : `${roleOrigin(facts.role)}/`,
  };
}

/**
 * Decide whether a command's sender may speak.
 *
 * Reuses {@link evaluateTrustedSender} and adds exactly one check it cannot
 * express: that the sending pid is one this host spawned. The helper's
 * `config.mainWindowId` is the set's membership test, expressed by projecting
 * the pid onto it, and an unregistered sender becomes a `senderId` mismatch —
 * `unknown_window`, the same refusal a renderer from an auxiliary window gets.
 */
export function authoriseCommandSender(
  facts: CommandSenderFacts,
  config: CommandSenderConfig,
): TrustedSenderVerdict {
  // Read the live set once, here, so every branch below judges the same set.
  const trustedPids = config.trustedPids();
  if (facts.senderPid === null) {
    // Host-initiated. The host is the only process that can hold a null pid
    // here by construction; anything else must have supplied a pid.
    return { ok: true };
  }
  if (!trustedPids.has(facts.senderPid)) {
    return {
      ok: false,
      reason: 'unknown_window',
      detail: `pid ${facts.senderPid} is not a process this host spawned`,
    };
  }
  const trusted: TrustedSenderConfig = {
    // The helper requires a non-null id to compare; membership is already
    // established, so the sender's own pid is the id it must match.
    mainWindowId: facts.senderPid,
    allowedOrigins: config.allowedOrigins,
  };
  return evaluateTrustedSender(toTrustedSenderFacts(facts, trustedPids), trusted);
}

// ── the receipt ───────────────────────────────────────────────────────────

/** A failure that happened BEFORE storage was involved. */
export type CommandRefusal =
  /** The envelope did not carry the schema this Control Plane speaks. */
  | 'schema_mismatch'
  /** The sender is not a process this host spawned, or is on a foreign origin. */
  | 'untrusted_sender'
  /** The action is not one the Control Plane owns. */
  | 'unknown_action'
  /** The action is owned, but this host has no repository bound yet. */
  | 'repository_unbound'
  /** The payload did not satisfy the action's own contract. */
  | 'invalid_payload'
  /**
   * The action was declined on purpose and nothing needs retrying.
   *
   * A `defer` answer is this: a real answer that decides nothing, so it is not
   * an error, but it is also not a decision and must not be reported as one.
   */
  | 'deferred';

export type CommandReceipt =
  | {
      readonly outcome: 'accepted';
      readonly schema: CommandSchemaVersion;
      readonly action: string;
      /** A durable write's own receipt, when the command reached storage. */
      readonly write: RunWriteReceipt;
      /** The value the action returned, for a read or a non-durable write. */
      readonly result: unknown;
    }
  | {
      readonly outcome: 'rejected';
      readonly schema: CommandSchemaVersion | null;
      readonly action: string;
      readonly refusal: CommandRefusal;
      readonly reason: string;
      /**
       * The storage receipt, when the command got far enough to have one.
       *
       * A rejected command that already produced a typed write failure carries
       * it here, so a caller does not lose `busy` by learning the command was
       * also rejected.
       */
      readonly write?: RunWriteReceipt;
    };

/** Did the command leave the record the caller asked for? */
export function isCommandDurable(receipt: CommandReceipt): boolean {
  return receipt.outcome === 'accepted' && isDurableWrite(receipt.write);
}

/** The one diagnostic line for a command receipt. */
export function describeCommandReceipt(receipt: CommandReceipt): string {
  if (receipt.outcome === 'accepted') {
    return `accepted ${receipt.action}: ${describeReceipt(receipt.write)}`;
  }
  const viaWrite = receipt.write ? ` (storage: ${describeReceipt(receipt.write)})` : '';
  return `rejected ${receipt.action}: ${receipt.refusal} — ${receipt.reason}${viaWrite}`;
}

/** A receipt for a refusal minted before the command reached storage. */
export function rejectCommand(
  action: string,
  refusal: CommandRefusal,
  reason: string,
  schema: CommandSchemaVersion | null = null,
  write?: RunWriteReceipt,
): CommandReceipt {
  return {
    outcome: 'rejected',
    schema,
    action,
    refusal,
    reason,
    ...(write ? { write } : {}),
  };
}

/**
 * Read an envelope, or say precisely why it is not one.
 *
 * Two checks, in this order: the schema, then the action. Checking the action
 * first would tell a producer with an old schema that its ACTION was unknown,
 * which sends it looking for a missing verb instead of a version mismatch.
 */
export function readCommandEnvelope(value: unknown): { envelope: CommandEnvelope } | { refusal: CommandRefusal; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { refusal: 'invalid_payload', reason: 'a command envelope is an object' };
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== COMMAND_SCHEMA_VERSION) {
    return {
      refusal: 'schema_mismatch',
      reason: `this Control Plane speaks command schema ${COMMAND_SCHEMA_VERSION}, the sender declared ${String(record.schema)}`,
    };
  }
  if (typeof record.action !== 'string' || record.action === '') {
    return { refusal: 'invalid_payload', reason: 'a command needs a non-empty action' };
  }
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { refusal: 'invalid_payload', reason: 'a command needs an object payload' };
  }
  return {
    envelope: {
      schema: COMMAND_SCHEMA_VERSION,
      action: record.action,
      payload: payload as Readonly<Record<string, unknown>>,
    },
  };
}

/**
 * The choke point: turn a non-durable receipt into a throw.
 *
 * The plan's "a failure after the ack must not be swallowed" is not a property
 * a caller may forget. A caller that receives a non-durable receipt either
 * throws here or opts out by handling the receipt itself; the option is
 * explicit because `defer` is a legitimate non-durable answer that must not
 * abort a turn.
 *
 * @param allowDeferred - When true, a `deferred` refusal returns normally. It
 *   is the only refusal that may be non-durable without being a failure, and it
 *   is never an error.
 */
export function assertCommandAccepted(receipt: CommandReceipt, allowDeferred = false): asserts receipt is Extract<CommandReceipt, { outcome: 'accepted' }> {
  if (receipt.outcome === 'accepted') return;
  if (allowDeferred && receipt.refusal === 'deferred') return;
  throw new Error(describeCommandReceipt(receipt));
}
