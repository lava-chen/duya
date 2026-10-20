/**
 * run-turn-overrides.ts — what the Host decides about one turn's configuration.
 *
 * ## Why this is a separate file
 *
 * Everything here is a PURE decision about values, and it is the part of the
 * run-start path that decides whether a turn may run at all. Keeping it out of
 * `run-execution.ts` means it can be tested without a Host, a database and a
 * worker, and it means the rule that a delegated run may not widen its
 * parent's policy is stated in exactly one place.
 *
 * ## The rule this file exists to enforce
 *
 * A caller states what it wants. The Host decides what it gets. Those are
 * two different statements, and before this file they were the same
 * statement: `StartAgentRunInput.options` was a free bag, so a caller could
 * name the permission mode in it and the bag's value would travel to the
 * worker as if the Host had resolved it.
 *
 * So the bag is no longer allowed to carry the fields the Host adjudicates.
 * They are named on the request, validated here, and the RESOLVED value is
 * what reaches the manifest and the worker. A bag that still carries one of
 * them has it taken away, and the resolution says so — silently keeping it
 * would be the bypass this file closes, and silently dropping it without
 * saying so would be a second kind of lie.
 *
 * ## Why an invalid value is REFUSED rather than ignored
 *
 * A request that names a permission mode the protocol does not have is a
 * request the Host cannot honour. Dropping the field would start the run
 * under a mode the caller did not ask for and believe it had; that is the
 * silent substitution the manifest's own provenance rules exist to prevent.
 * So the run does not start, and the refusal names the field.
 */

import {
  isPermissionPolicyMode,
  lessPermissivePermissionMode,
  type FileAttachment,
  type PermissionPolicyMode,
  type PermissionRulesWire,
} from '@duya/agent-protocol';

/**
 * The option-bag keys the Host adjudicates.
 *
 * A bag that carries one of these is not rejected — the bag is how the
 * Desktop's legacy turn fields travel, and rejecting a whole turn over one
 * key would be a regression — but the key is REMOVED and the Host's own
 * resolved value is what goes on the wire.
 *
 * `permissionModeOverride` is here because it is the legacy carrier of the
 * same decision in the AGENT's mode space (`default` / `auto` /
 * `bypassPermissions`). Leaving it in the bag would let a caller set the
 * mode the worker applies without the Host ever resolving it, which is the
 * bypass in its most direct form.
 */
export const HOST_ADJUDICATED_OPTION_KEYS: readonly string[] = [
  'permissionMode',
  'permissionModeOverride',
  'agentProfileId',
  'modes',
  'tools',
  'permissionRules',
  'hostSwitch',
];

/** The turn's own request, as it arrived. */
export interface TurnOverrideRequest {
  readonly permissionMode?: unknown;
  readonly agentProfileId?: unknown;
  readonly effort?: unknown;
  readonly attachments?: unknown;
  readonly modes?: unknown;
  readonly tools?: unknown;
  readonly permissionRules?: unknown;
}

/** What the Host already knows, before the request is considered. */
export interface TurnOverrideStanding {
  /** The session's own permission mode, already in the protocol's space. */
  readonly permissionMode?: PermissionPolicyMode;
  /** The session's agent profile, if it has one. */
  readonly agentProfileId?: string | null;
}

/** The parent run's recorded policy, for a delegated turn. */
export interface TurnOverrideParent {
  readonly permissionMode?: PermissionPolicyMode;
}

export interface ResolveTurnOverridesInput {
  readonly request: TurnOverrideRequest;
  readonly standing: TurnOverrideStanding;
  /** Present only for a delegated run. */
  readonly parent?: TurnOverrideParent;
  /** The caller's free option bag. */
  readonly options: Readonly<Record<string, unknown>>;
}

export type TurnOverrideResolution =
  | {
      readonly ok: true;
      /** The mode the run will be recorded under. */
      readonly permissionMode: PermissionPolicyMode | undefined;
      /** The profile the turn runs under, or `null` for none. */
      readonly agentProfileId: string | null | undefined;
      /** The reasoning effort, when the turn named one. */
      readonly effort: string | undefined;
      /** The bag the Host will hand on: adjudicated keys removed. */
      readonly options: Readonly<Record<string, unknown>>;
      /** The bag keys the Host took away, so a caller can be told. */
      readonly strippedOptionKeys: readonly string[];
      /** The turn's attachments, as the worker will receive them. */
      readonly attachments: readonly FileAttachment[] | undefined;
      /** The modes the turn declares. */
      readonly modes: readonly string[] | undefined;
      /** The tools the turn declares. */
      readonly tools: readonly string[] | undefined;
      /** The turn's permission rules, in the protocol's wire form. */
      readonly permissionRules: PermissionRulesWire | undefined;
    }
  | {
      readonly ok: false;
      /** The field that was wrong, named the way the caller sent it. */
      readonly field: string;
      /** Why it was wrong, in one sentence. */
      readonly reason: string;
    };

/**
 * Resolve one turn's configuration.
 *
 * The order matters and is not arbitrary:
 *
 *  1. VALIDATE first. A value the Host cannot honour refuses the turn; it
 *     never falls back to a default.
 *  2. Then the PARENT'S CEILING. A delegated run may ask for a narrower mode
 *     than the run that spawned it, and never a wider one — a sub-agent that
 *     could widen its own policy would make the parent's policy advisory.
 *  3. Then the SESSION'S STANDING mode, for a turn that asked for nothing.
 *  4. Then the BAG, with the adjudicated keys taken out and the resolved
 *     values put in.
 */
export function resolveTurnOverrides(input: ResolveTurnOverridesInput): TurnOverrideResolution {
  const requestedMode = readPermissionMode(input.request.permissionMode);
  if (requestedMode.ok === false) return requestedMode;

  const requestedProfile = readAgentProfileId(input.request.agentProfileId);
  if (requestedProfile.ok === false) return requestedProfile;

  const requestedEffort = readEffort(input.request.effort, input.options['effort']);
  if (requestedEffort.ok === false) return requestedEffort;

  const requestedAttachments = readAttachments(input.request.attachments, input.options['files']);
  if (requestedAttachments.ok === false) return requestedAttachments;

  const requestedModes = readNameList(input.request.modes, 'modes');
  if (requestedModes.ok === false) return requestedModes;

  const requestedTools = readNameList(input.request.tools, 'tools');
  if (requestedTools.ok === false) return requestedTools;

  const requestedRules = readPermissionRules(input.request.permissionRules);
  if (requestedRules.ok === false) return requestedRules;

  // The mode the turn ASKS for, before any ceiling applies.
  const asked = requestedMode.mode ?? input.standing.permissionMode;

  // A delegated run's ceiling is its parent's recorded mode. Narrowing below
  // it is allowed; widening above it is not, and the resolution is the
  // parent's, not the caller's.
  const permissionMode =
    asked === undefined
      ? undefined
      : input.parent?.permissionMode === undefined
        ? asked
        : lessPermissivePermissionMode(asked, input.parent.permissionMode);

  // The profile falls back to the session's, and an explicit `null` means
  // "no profile" rather than "unset" — so it is carried through as `null`
  // rather than being dropped.
  const agentProfileId =
    requestedProfile.profile === undefined ? input.standing.agentProfileId : requestedProfile.profile;

  const { options, stripped } = stripAdjudicatedKeys(input.options);
  if (permissionMode !== undefined) options['permissionMode'] = permissionMode;
  if (agentProfileId !== undefined && agentProfileId !== null) {
    options['agentProfileId'] = agentProfileId;
  }
  // The attachments travel in the EXISTING carrier: the worker reads the
  // turn's `files` and commits them onto the user message, and the turn's
  // digest names them by their ids. Putting them anywhere else would be a
  // second path to the same files.
  if (requestedAttachments.attachments !== undefined) {
    options['files'] = requestedAttachments.attachments;
  }

  return {
    ok: true,
    permissionMode,
    agentProfileId,
    effort: requestedEffort.effort,
    options,
    strippedOptionKeys: stripped,
    attachments: requestedAttachments.attachments,
    modes: requestedModes.names,
    tools: requestedTools.names,
    permissionRules: requestedRules.rules,
  };
}

/**
 * Take the adjudicated keys out of the bag.
 *
 * The resolved values go back in under their own names, so the worker
 * receives what the Host decided rather than what the caller asked for.
 */
function stripAdjudicatedKeys(
  options: Readonly<Record<string, unknown>>,
): { options: Record<string, unknown>; stripped: readonly string[] } {
  const out: Record<string, unknown> = { ...options };
  const stripped: string[] = [];
  for (const key of HOST_ADJUDICATED_OPTION_KEYS) {
    if (key in out) {
      delete out[key];
      stripped.push(key);
    }
  }
  return { options: out, stripped };
}

function readPermissionMode(value: unknown):
  | { readonly ok: true; readonly mode: PermissionPolicyMode | undefined }
  | { readonly ok: false; readonly field: string; readonly reason: string } {
  if (value === undefined) return { ok: true, mode: undefined };
  if (!isPermissionPolicyMode(value)) {
    return {
      ok: false,
      field: 'permissionMode',
      reason: `is not a permission policy mode; expected one of default, acceptEdits, plan, bypassPermissions, dontAsk`,
    };
  }
  return { ok: true, mode: value };
}

function readAgentProfileId(value: unknown):
  | { readonly ok: true; readonly profile: string | null | undefined }
  | { readonly ok: false; readonly field: string; readonly reason: string } {
  if (value === undefined) return { ok: true, profile: undefined };
  if (value === null) return { ok: true, profile: null };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      ok: false,
      field: 'agentProfileId',
      reason: 'must be a non-empty profile id, or null for no profile',
    };
  }
  return { ok: true, profile: value };
}

/**
 * The turn's reasoning effort.
 *
 * The typed field wins. The bag's `effort` is accepted as a SECOND carrier
 * because the Web BFF and the legacy turn options both put it there, and
 * dropping it would silently change what the model is asked to do — the one
 * thing a caller of that bag is guaranteed to notice. It is lifted into the
 * typed field so there is still ONE source of truth: the manifest's
 * `agent.effort`, which the worker reads.
 */
function readEffort(typed: unknown, bagged: unknown):
  | { readonly ok: true; readonly effort: string | undefined }
  | { readonly ok: false; readonly field: string; readonly reason: string } {
  const value = typed !== undefined ? typed : bagged;
  if (value === undefined) return { ok: true, effort: undefined };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      ok: false,
      field: typed !== undefined ? 'effort' : 'options.effort',
      reason: 'must be a non-empty string',
    };
  }
  return { ok: true, effort: value };
}

/**
 * The turn's attachments.
 *
 * The typed field is the authority when it is present; the bag's `files` is
 * the carrier it travels in, and the one every existing caller already uses.
 * A bag that carries `files` while the typed field says something else is
 * not two answers to keep — it is one answer with a stale copy of itself, so
 * the typed list replaces it.
 *
 * An attachment without an id is refused. The id IS the attachment's
 * identity: the turn's digest names attachments by their ids, so an
 * attachment that has none cannot be distinguished from another one that
 * has none, and two different files would hash the same.
 */
function readAttachments(typed: unknown, bagged: unknown):
  | { readonly ok: true; readonly attachments: readonly FileAttachment[] | undefined }
  | { readonly ok: false; readonly field: string; readonly reason: string } {
  if (typed === undefined) {
    if (bagged === undefined) return { ok: true, attachments: undefined };
    if (!Array.isArray(bagged)) {
      return { ok: false, field: 'options.files', reason: 'must be an array of attachments' };
    }
    return { ok: true, attachments: bagged as readonly FileAttachment[] };
  }
  if (!Array.isArray(typed)) {
    return { ok: false, field: 'attachments', reason: 'must be an array of attachments' };
  }
  for (const [index, file] of typed.entries()) {
    if (typeof file !== 'object' || file === null) {
      return { ok: false, field: `attachments[${index}]`, reason: 'must be an attachment object' };
    }
    const id = (file as { readonly id?: unknown }).id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      return {
        ok: false,
        field: `attachments[${index}].id`,
        reason: 'must be a non-empty id; it is the attachment identity the turn is digested by',
      };
    }
  }
  return { ok: true, attachments: typed as readonly FileAttachment[] };
}

/**
 * A list of names the turn declares — the modes it runs under, the tools it
 * uses.
 *
 * The names are recorded, not resolved: the manifest says what the turn
 * asked for and the worker says what it actually has. An empty name is
 * refused rather than dropped, because a list with a hole in it reads as a
 * shorter list and the difference is invisible in the record.
 */
function readNameList(value: unknown, field: string):
  | { readonly ok: true; readonly names: readonly string[] | undefined }
  | { readonly ok: false; readonly field: string; readonly reason: string } {
  if (value === undefined) return { ok: true, names: undefined };
  if (!Array.isArray(value)) {
    return { ok: false, field, reason: 'must be an array of names' };
  }
  for (const [index, name] of value.entries()) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, field: `${field}[${index}]`, reason: 'must be a non-empty name' };
    }
  }
  return { ok: true, names: value as readonly string[] };
}

/**
 * The turn's permission rules, in the protocol's wire form.
 *
 * The shape is checked rather than cast: a rule table that is a `Map`
 * serialises to `{}`, and a manifest whose `rules` are `{}` says "no rule
 * allows anything" while looking like "the rules were lost". A value that
 * is not the shape is refused, because a rule table nobody can read is
 * worse than no rule table.
 */
function readPermissionRules(value: unknown):
  | { readonly ok: true; readonly rules: PermissionRulesWire | undefined }
  | { readonly ok: false; readonly field: string; readonly reason: string } {
  if (value === undefined) return { ok: true, rules: undefined };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, field: 'permissionRules', reason: 'must be a record of source to tool names' };
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, field: 'permissionRules', reason: 'must be a plain record of source to tool names' };
  }
  const out: Record<string, readonly string[]> = {};
  for (const [source, tools] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(tools)) {
      return { ok: false, field: `permissionRules.${source}`, reason: 'must be an array of tool names' };
    }
    for (const [index, tool] of tools.entries()) {
      if (typeof tool !== 'string' || tool.trim().length === 0) {
        return { ok: false, field: `permissionRules.${source}[${index}]`, reason: 'must be a non-empty tool name' };
      }
    }
    out[source] = tools as readonly string[];
  }
  return { ok: true, rules: out as PermissionRulesWire };
}
