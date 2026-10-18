/**
 * The client half of the capability handshake: what the CLI can CONSUME, what
 * the Host can PROVIDE, and the refusal text a user sees when the two do not
 * meet.
 *
 * ## The two axes, kept apart
 *
 * `HostDeclaration.capabilities` is what this client can CONSUME from a runtime
 * (`PROTOCOL_CAPABILITIES`, six names). `HostHandshakeV1.provides` is what the
 * Host can SERVE (`HOST_CAPABILITIES`, twenty-two names). Neither is inferable
 * from the other, and `agent-protocol/src/version.ts:116` exists because
 * collapsing them produces a handshake in which the runtime concludes the host
 * can execute something merely because the host offered to serve it. So this
 * module keeps `consumed` and `provided` in separate fields and never
 * compares one against the other.
 *
 * ## By name, and why that is complete here rather than by luck
 *
 * The gate compares capability NAMES. `20-capability-directions.md` §4 names
 * three pairs that are one predicate under two names — `checkpoint_repository`
 * / `checkpoint_resume`, `permission_coordinator` / `permission_expiry`,
 * `tool_preview` / `tool_call_preview` — and a name gate cannot see an alias.
 * All three pairs are EXECUTE against CONSUME. None of the six names involved
 * appears in `HOST_CAPABILITIES`, so on the PROVIDE axis there is no alias pair
 * today and a name gate is equivalent to a predicate gate here. That is an
 * assertion, not a hope: the last case in
 * `test/capability-degradation.test.ts` pins it, and goes red the day a
 * provide-side alias lands.
 *
 * If it does land, the fix is to compare the underlying predicate, not to keep
 * the name gate: two names for one predicate mean the Host answers for the
 * predicate it can actually serve.
 *
 * ## An absent declaration is a refusal, not an all-clear
 *
 * An older Host answers `/healthz` with `ok`, `apiVersion` and
 * `databaseReady` and says nothing about what it provides. Reading that as
 * "nothing is missing" is the fail-open shape this module exists to remove, so
 * a missing `provides` refuses with its own reason and names the capability it
 * refused. `provided` is `null` in that case precisely so a caller cannot tell
 * "the Host provides nothing" from "the Host never said", and the counts can
 * never quietly read as a pass.
 *
 * ## An advertised capability is not a credential
 *
 * Passing this gate says the Host can serve the capability. It says nothing
 * about whether a given caller may ask. Every request still crosses the Host
 * bearer check and the per-route validation, and `requestWorkspaceFileRead`
 * deliberately returns the Host refusal rather than translating it into a gate
 * result.
 */

import {
  CURRENT_VERSION,
  PROTOCOL_SCHEMA_REVISION,
  type HostCapability,
  type HostDeclaration,
  type ProtocolCapability,
} from '@duya/agent-protocol';
import type { HostRolloutImportResult } from '@duya/agent-protocol/session-api';
import type { HostHandshakeV1, HostSessionHttpClient } from '@duya/host/http-client';

/**
 * The one interface capability closed end to end here: reading a file that
 * lives in the agent workspace.
 *
 * Named `workspace_filesystem` and not `workspace.read`: `workspace.read` is
 * the Desktop PLUGIN permission vocabulary (`packages/plugin-core`,
 * `apps/desktop/src/renderer/components/settings/capabilities`), a different
 * axis with a different owner. Reusing it in a protocol handshake would put a
 * plugin grant on the provide axis.
 *
 * Owner `runtime`, so it follows the workspace rather than the user: a client
 * on another machine can still read the remote workspace through this Host.
 */
export const WORKSPACE_READ_CAPABILITY = 'workspace_filesystem' satisfies HostCapability;

/**
 * What the CLI consumes, measured rather than assumed.
 *
 * The three names are the event types `tui/host-event-stream.ts` and
 * `chat.ts` actually project: `tool.call_preview`, the discriminated
 * `tool.call_completed` outcome union, and `assistant.usage`.
 *
 * The other three are deliberately NOT declared. `permission_expiry` also
 * requires handling `permission.expired`, which the CLI has no branch for, and
 * `replay` and `checkpoint_resume` need a resume path the CLI does not have.
 * Declaring them would be the promise nobody keeps that
 * `assertHostCapabilityConsistency` was written for — a capability the client
 * says it consumes, that it then drops on the floor.
 */
export const CLI_HOST_DECLARATION: HostDeclaration = {
  host: { name: 'duya-cli', version: '0.1.0' },
  protocol: CURRENT_VERSION,
  schemaRevision: PROTOCOL_SCHEMA_REVISION,
  capabilities: ['tool_call_preview', 'tool_outcome_detail', 'usage_accounting'],
};

export interface CapabilityRefusal {
  readonly capability: HostCapability;
  /** User-visible text. Never empty, never a placeholder. */
  readonly reason: string;
}

export interface HostCapabilityNegotiation {
  /** What the client said it can consume. */
  readonly consumed: readonly ProtocolCapability[];
  /** What the Host said it provides, or `null` when it said nothing. */
  readonly provided: readonly HostCapability[] | null;
  /** Requirements this Host serves. */
  readonly accepted: readonly HostCapability[];
  /** Requirements it does not, each with the reason to print. */
  readonly refused: readonly CapabilityRefusal[];
}

function hostLabel(handshake: HostHandshakeV1): string {
  const name = handshake.host?.name;
  if (name === undefined) return 'the Duya Host';
  return handshake.host?.version === undefined ? name : `${name} ${handshake.host.version}`;
}

/**
 * The text a user sees when a capability is refused.
 *
 * Always names the Host and the capability. A refusal a user cannot read is
 * indistinguishable from a crash, which is what this whole card is about.
 */
export function describeRefusal(
  handshake: HostHandshakeV1,
  capability: HostCapability,
): string {
  const label = hostLabel(handshake);
  const provided = handshake.provides;
  if (provided === undefined) {
    return `${label} did not declare the capabilities it provides; refusing ${capability} rather than assuming it is supported`;
  }
  const reason = handshake.unsupported?.[capability];
  const suffix = reason === undefined || reason.length === 0
    ? 'no reason was given'
    : reason;
  return `${label} does not provide ${capability}: ${suffix}`;
}

/**
 * Compute what this client may rely on.
 *
 * @param requirements - Provide-side capabilities the caller is about to use.
 */
export function negotiateHostCapabilities(
  declaration: HostDeclaration,
  handshake: HostHandshakeV1,
  requirements: readonly HostCapability[],
): HostCapabilityNegotiation {
  const provided = handshake.provides ?? null;
  const served = new Set<HostCapability>(provided ?? []);
  const accepted: HostCapability[] = [];
  const refused: CapabilityRefusal[] = [];
  for (const requirement of requirements) {
    if (served.has(requirement)) accepted.push(requirement);
    else refused.push({ capability: requirement, reason: describeRefusal(handshake, requirement) });
  }
  return { consumed: declaration.capabilities, provided, accepted, refused };
}

export type WorkspaceFileReadResult =
  | { readonly status: 'read'; readonly result: HostRolloutImportResult }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Read a workspace file through the Host, but only if the Host said it can.
 *
 * The Host call is `POST /v1/local/rollouts/import`: the one route whose job
 * is reading a file out of the workspace on the client's behalf, with the Host
 * resolving the path and validating the transcript. A dedicated
 * `/v1/workspace/file` endpoint would be a Host route addition and belongs to
 * the L-HOST lane; this card wires the gate around the call that exists.
 *
 * A refusal returns before any request is issued, so an unsupported
 * capability costs one handshake rather than a failed round trip. A refusal
 * from the HOST is still thrown: the gate said the capability exists, not that
 * this caller may use it.
 */
export async function requestWorkspaceFileRead(
  client: HostSessionHttpClient,
  handshake: HostHandshakeV1,
  sourcePath: string,
): Promise<WorkspaceFileReadResult> {
  const negotiation = negotiateHostCapabilities(CLI_HOST_DECLARATION, handshake, [WORKSPACE_READ_CAPABILITY]);
  const refusal = negotiation.refused[0];
  if (refusal !== undefined) return { status: 'refused', reason: refusal.reason };
  const result = await client.importRollout({ sourcePath, mode: 'restore' });
  return { status: 'read', result };
}
