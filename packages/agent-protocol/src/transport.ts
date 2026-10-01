/**
 * Transport BINDINGS. Zero adapters live here.
 *
 * Design source: 07-agent-protocol-spec.md §12.
 *
 * The protocol defines ports, not sockets. `EventSink` / `EventSource` are
 * channel primitives and live in `envelope.ts`; this module is the layer that
 * binds a manifest, an input, and a control channel into one host-facing
 * `RuntimeBinding`. `EventSink` / `EventSource` / `ControlChannel` are identical
 * under all three transports; only framing, backpressure, and error mapping
 * differ, and those belong to the adapters in
 * `packages/agent-runtime/transport/*`.
 *
 * Reference: pi-protocol's README says the same thing in prose — "This package
 * does not bundle a transport." Its `package.json` has a single `exports: {"."}`
 * and no transport code, and the protocol package is importable from a
 * renderer, a subprocess, and a plain Node test with no platform assumptions.
 *
 * 02-reference-repo-boundaries.md:220 warns that "two SDKs over two transports"
 * was a negative lesson. drift test #13 is the parity proof for that.
 */

import type { PermissionAck, PermissionDecision } from './permission.js';
import type { RuntimeCapabilities, ProbeOptions, TransportKind } from './capabilities.js';
import type { RunHandle, RunInput, StartOptions, CancelReason, CancelOutcome } from './run.js';
import type { RunManifest } from './manifest.js';
import type { ResumeRequest } from './resume.js';
import type { WireResult } from './errors.js';

export type ControlMethod =
  | 'run.start'
  | 'run.cancel'
  | 'run.pause'
  | 'run.resume'
  | 'permission.respond'
  | 'permission.setMode'
  | 'runtime.probe'
  | 'runtime.ping';

export type ControlParams = Readonly<Record<string, unknown>>;
export type ControlResult = WireResult<unknown>;

/** Bidirectional control plane. Cancel/pause/resume/permission all ride here;
 *  they are NOT events. */
export interface ControlChannel {
  request<M extends ControlMethod>(
    method: M,
    params?: ControlParams,
  ): Promise<ControlResult>;
  notify<M extends ControlMethod>(method: M, params?: ControlParams): Promise<void>;
  readonly signal: AbortSignal;
}

/** One binding per host model. The three are fully interchangeable. */
export interface RuntimeBinding {
  readonly transport: TransportKind;
  probe(opts?: ProbeOptions): Promise<RuntimeCapabilities>;
  start(manifest: RunManifest, input: RunInput, opts?: StartOptions): Promise<RunHandle>;
  resume(manifest: RunManifest, request: ResumeRequest, input?: RunInput): Promise<RunHandle>;
  close(): Promise<void>;
}

export type { CancelOutcome, CancelReason, PermissionAck, PermissionDecision, RunHandle, RunInput, StartOptions };