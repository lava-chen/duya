/**
 * Host capabilities: what a host can OFFER a client.
 *
 * ## Why this file exists, given the two declarations already here
 *
 * The protocol already models both ends of the runtime/host conversation, and
 * both are about CONSUMPTION:
 *
 *  - `RuntimeCapabilities` — what the runtime can DO during a run.
 *  - `HostDeclaration` — what this host can CONSUME from a runtime.
 *
 * Neither answers the question a UI actually asks. A component holding a
 * "choose a directory" affordance is not asking whether the runtime can resume
 * from a checkpoint, nor whether this host consumes one; it is asking whether
 * the thing on the other end of the socket can produce a directory list. With no
 * vocabulary for that, the answer degrades into per-callpoint feature detection,
 * which is exactly what `window.electronAPI?.` already is.
 *
 * ## The measurement behind this list
 *
 * Every entry below was extracted from the renderer import closure, not chosen by
 * taste. The reference counts are `window.electronAPI` value references in
 * `apps/desktop/src/renderer` at `c3a1ed41` (115 files / 518 refs), from
 * `docs/exec-plans/active/610-architecture-series/16-a8-ui-census.md` §9. An entry
 * with no measured caller does not belong here: a capability nobody reads is a
 * promise nobody keeps, which is the failure `assertCapabilityConsistency` was
 * written for.
 *
 * ## Why each entry carries an OWNER
 *
 * A flat list of names would be wrong in a way that only shows up in production.
 * `00-contracts.md` §1.2 gives workspace filesystem and shell to the RUNTIME, not
 * to the control plane — while the desktop implementation exposes both through
 * Electron main. So "filesystem" means two different things depending on where
 * the client runs, and a client that assumes the host-local reading will, on a
 * cloud deployment, offer a file picker that can only ever open the server's
 * disk.
 *
 * Hence `CapabilityOwner`:
 *
 *  - `host-local` — served by the process the client is embedded in. Absent for
 *    a browser client, and that absence is correct, not a bug to work around.
 *  - `runtime`    — reachable through the control plane to the agent's runtime,
 *    so it follows the WORKSPACE, not the user. A cloud client can still browse
 *    the remote workspace here.
 *  - `both`       — served host-locally when present, and the client must say
 *    which one it got.
 *
 * The owner axis is the part that is easy to leave out and expensive to add
 * later: it changes what a component is allowed to promise its user.
 */

import type { ProtocolVersion } from './version.js';

/**
 * Who can actually serve a capability.
 *
 * See the file header: without this axis, `filesystem` is ambiguous between "the
 * user's disk" and "the workspace the agent is running in", and those are
 * different disks on different machines.
 */
export type CapabilityOwner = 'host-local' | 'runtime' | 'both';

export const HOST_CAPABILITIES = [
  /** Browse / read / write / rename / delete / preview files. `runtime` (the workspace). */
  'workspace_filesystem',
  /** Status, diff, commits, branches, in-app review. `runtime` (the workspace repo). */
  'workspace_git',
  /** Directory and file pickers. `host-local`; a browser client gets the input element instead. */
  'native_dialog',
  /** Open a path, open an external URL, reveal in file manager. `host-local`. */
  'os_shell',
  /** Settings key/value store, including the durable second layer. `host-local`. */
  'settings_store',
  /** Desktop notifications for run completion. `host-local`. */
  'system_notification',
  /** Vision-capable models and their per-provider toggles. `host-local`. */
  'vision_models',
  /** Create / update / delete model providers, and reinitialise the runtime after. `host-local`. */
  'provider_crud',
  /** Discover the agent server and config ports on this machine. `host-local`; absent in a browser by design. */
  'port_discovery',
  /** Microphone capture and transcription. `host-local`; browsers may gate it behind a permission prompt. */
  'voice_capture',
  /** Screen recording. `host-local`. */
  'screen_recording',
  /** Locate, export and clear the application log. `host-local`. */
  'log_files',
  /** Session, thread and message persistence. `both`: the desktop keeps a local copy, and the control plane is authoritative. */
  'session_persistence',
  /** Registered projects and their working directories. `both`. */
  'project_registry',
  /** Scheduled and recurring runs. `host-local` control plane surface. */
  'cron',
  /** Workflow runs and their graphs. `host-local`. */
  'workflow',
  /** Skill inventory and install state. `host-local`. */
  'skills',
  /** Hook inventory and configuration. `host-local`. */
  'hooks',
  /** Inbound and queued messages awaiting a turn. `both`. */
  'inbox',
  /** Installed plugins and their trust state. `host-local`. */
  'plugins',
  /** The canvas surface. `host-local`. */
  'canvas',
  /** The Orb surface. `host-local`. */
  'orb',
] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

/**
 * Owner per capability.
 *
 * Typed as a total `Record` rather than a partial map so that adding a
 * `HOST_CAPABILITIES` entry without deciding its owner is a TYPE ERROR, not a
 * silent `undefined` a client would read as "host-local" by accident.
 */
export const HOST_CAPABILITY_OWNERS: Readonly<Record<HostCapability, CapabilityOwner>> = {
  workspace_filesystem: 'runtime',
  workspace_git: 'runtime',
  native_dialog: 'host-local',
  os_shell: 'host-local',
  settings_store: 'host-local',
  system_notification: 'host-local',
  vision_models: 'host-local',
  provider_crud: 'host-local',
  port_discovery: 'host-local',
  voice_capture: 'host-local',
  screen_recording: 'host-local',
  log_files: 'host-local',
  session_persistence: 'both',
  project_registry: 'both',
  cron: 'host-local',
  workflow: 'host-local',
  skills: 'host-local',
  hooks: 'host-local',
  inbox: 'both',
  plugins: 'host-local',
  canvas: 'host-local',
  orb: 'host-local',
};

/** A host's identity, distinct from the RUNTIME's identity in `RuntimeCapabilities`. */
export interface HostIdentity {
  readonly name: string;
  readonly version: string;
  /**
   * `desktop` embeds a Node-bearing main process; `web` is a browser;
   * `headless` is the CLI/CI shape. This is a claim the client may branch on
   * ONLY for genuinely structural differences — never to ask for a capability,
   * which is what `provides` is for.
   */
  readonly kind: 'desktop' | 'web' | 'headless';
}

export interface HostCapabilities {
  readonly protocol: ProtocolVersion;
  readonly host: HostIdentity;
  /**
   * The single source of truth. A component that needs `native_dialog` reads it
   * from here and renders a disabled affordance when it is missing — it does
   * not call and hope.
   *
   * Absence is legal and meaningful: a browser host genuinely cannot offer
   * `os_shell`. Absence must never be papered over with an optional-chained call
   * that silently returns null, because a client cannot tell "the host cannot do
   * this" from "the host failed", and it will render an empty screen instead of
   * an explanation.
   */
  readonly provides: readonly HostCapability[];
  /** Optional detail. Present only for capabilities whose limits a client must honour. */
  readonly limits?: {
    /** Bytes a single file transfer may reach, if the host enforces one. */
    readonly maxFileBytes?: number;
    /** Whether a missing capability should surface as an error or as a disabled control. */
    readonly absentCapabilityPolicy?: 'error' | 'disable';
  };
}

/** What a component needs before it may render its affordance. */
export interface HostCapabilityRequirement {
  readonly needs?: readonly HostCapability[];
  /**
   * Owner the component can actually work with. A component that needs to read
   * the USER's disk cannot be satisfied by a `runtime`-owned capability, and
   * saying so here turns that from a production surprise into a build-time one.
   */
  readonly owner?: CapabilityOwner;
}

export interface HostCapabilityProblem {
  readonly field: string;
  readonly advertised: string;
  readonly required: string;
}

function ownerOf(capability: HostCapability): CapabilityOwner {
  return HOST_CAPABILITY_OWNERS[capability];
}

/**
 * Whether a host satisfies a component's requirements.
 *
 * Two independent ways to fail, deliberately both reported:
 *  - the capability is not in `provides` at all;
 *  - it is provided, but by the wrong owner for what the component needs.
 */
export function assertHostSatisfies(
  capabilities: HostCapabilities,
  requirements: HostCapabilityRequirement,
): void {
  const needs = requirements.needs ?? [];
  for (const need of needs) {
    if (!capabilities.provides.includes(need)) {
      throw new Error(`host does not provide ${need} (host: ${capabilities.host.name})`);
    }
    if (requirements.owner !== undefined && ownerOf(need) !== requirements.owner) {
      throw new Error(
        `host provides ${need} as ${ownerOf(need)}, but the requirement is ${requirements.owner}`,
      );
    }
  }
}

export function hostSatisfies(
  capabilities: HostCapabilities,
  requirements: HostCapabilityRequirement,
): boolean {
  try {
    assertHostSatisfies(capabilities, requirements);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-check what a host ADVERTISES against what it actually registers.
 *
 * The parallel to `assertCapabilityConsistency`, and for the same reason: the
 * alternative is a promise nobody keeps. A host that lists `native_dialog` in
 * `provides` while its IPC surface has no such channel produces a file picker
 * that throws only when a user clicks it.
 *
 * `provides` is the declaration. `registered` is measured from the implementation
 * — the transport's actual channel list. They must agree.
 */
export function assertHostCapabilityConsistency(
  capabilities: HostCapabilities,
  registered: readonly string[],
): void {
  const problems: HostCapabilityProblem[] = [];

  for (const declared of capabilities.provides) {
    if (!registered.includes(declared)) {
      problems.push({ field: 'provides', advertised: declared, required: 'absent from registered channels' });
    }
  }
  for (const channel of registered) {
    if (!(HOST_CAPABILITIES as readonly string[]).includes(channel)) {
      problems.push({ field: 'registered', advertised: channel, required: 'not a known HostCapability' });
    } else if (!capabilities.provides.includes(channel as HostCapability)) {
      problems.push({ field: 'provides', advertised: 'absent', required: channel });
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `host capability mismatch: ${problems
        .map((p) => {
          if (p.field === 'registered') {
            return `registers ${p.advertised}, which is not a known HostCapability`;
          }
          if (p.advertised === 'absent') {
            return `registers ${p.required} but does not declare it in provides`;
          }
          return `declares ${p.advertised} but registers no such channel`;
        })
        .join('; ')}`,
    );
  }
}

/**
 * Capabilities a `host-local` consumer must never expect from a browser.
 *
 * Exported as data so a client can render its degraded layout in one pass
 * instead of discovering the gaps one `?.` at a time.
 */
export function hostLocalOnlyCapabilities(): readonly HostCapability[] {
  return HOST_CAPABILITIES.filter((c) => HOST_CAPABILITY_OWNERS[c] === 'host-local');
}
