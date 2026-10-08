/**
 * Plan 610 D2 -- `WorkerAdapterSurface`, the `chat:*` projection.
 *
 * ## What this implements, and why it is the ONLY place
 *
 * `WorkerAdapterSurface` (`engine/ports.ts:2131`) is the declaration of what the
 * worker ADAPTER must provide around an engine, and it had no implementation
 * anywhere in the repo. This is that implementation.
 *
 * Its two reachable obligations are deliberately NOT a second projector:
 *
 *  - `projectToLegacyFrame` REACHES `projectToLegacyFrame`
 *    (`project/legacy-sse-projector.ts:47`). It does not re-implement it. The
 *    switch there is the totality argument for the renderer's vocabulary --
 *    "for every event the run produces, the frame the renderer sees is the
 *    frame it saw before" -- and a copy would be a second mapping table that
 *    could disagree with the first while every test still passed.
 *  - `legacyFrameCodec` is the worker's OWN codec, supplied by the caller
 *    rather than imported. `convertSSEToAgentMessage` lives in
 *    `packages/agent/src/process/sse-frame-codec.ts`, a package that depends on
 *    this one; importing it here would invert the dependency. The headless path
 *    already reuses that same codec (`headless-run-host.ts:27`), so supplying
 *    it keeps ONE codec for production and headless.
 *
 * ## Why `bindEmitter` is a WRAPPER and not a replacement
 *
 * It returns a `RunEventStorePort` that forwards to the inner store, so the
 * engine keeps whatever the host bound -- including
 * `projectSubagentProgress`, which the engine publishes through. A binding
 * that rebuilt the store from the emitter would silently drop that method, and
 * the consequence is named in `ports.ts:1054-1062`: a dropped progress frame is
 * invisible everywhere except the sub-agent that produced it.
 *
 * ## The one thing the projector cannot do, and why it is here
 *
 * `projectToLegacyFrame` has no `result` arm, and it cannot grow one honestly:
 * `result` is not a legacy SSE type at all. It is a WORKER-CHANNEL frame, and
 * `convertSSEToAgentMessage` returns `null` for it precisely because the legacy
 * consumed it upstream of the codec (`sse-frame-codec.ts:242-243`). On the
 * legacy path the `result` frame is the one that carried a single LLM API call's
 * usage into the billing ledger (`agent-process-entry.ts:3161-3166`).
 *
 * So the surface emits it, in `projectUsageResults`, from the ONE event that
 * carries usage. It carries EXACTLY the fields the `assistant.usage` payload
 * holds.
 *
 * ## Per-call attribution: ANSWERED elsewhere, deliberately not here
 *
 * This member is TURN-level and stays that way, because `assistant.usage` is
 * turn-level: `AssistantMessage.addUsage` is last-wins-never-summed and
 * `#finalizeLastMessage` publishes it once per turn. Turning it into a per-call
 * stream would mean overriding that contract in the runtime and registering a
 * new event type, and the runtime has no honest per-call MODEL to stamp -- so a
 * per-call ledger minted here would bill a whole turn to whichever model was
 * frozen at run start, which is the wrong model after a mid-turn hot-swap.
 *
 * So per-call usage rides the HOST-side tap instead
 * (`ClientModelPortOptions.onPerCallUsage` in `packages/agent`, which cannot be
 * imported here): the provider's own block reaches the entry's existing billing
 * authority before `toModelFrame` narrows it, cache buckets included, and the
 * host stamps the model. This file keeps the turn-level projection it can
 * honestly make, and does not grow a second ledger beside it.
 */

import { projectToLegacyFrame } from '../project/legacy-sse-projector.js';
import type { RunEvent, RunEventEnvelope, TokenUsage } from '@duya/agent-protocol';
import type { LegacySseFrame } from '../legacy-sse-contract.js';
import type { RunEventEmitter } from '../events/event-emitter.js';
import type { RunEventStorePort } from './ports.js';
import type { WorkerAdapterSurface } from './ports.js';

/** The worker's own `chat:*` codec. `convertSSEToAgentMessage` in the worker. */
export type LegacyFrameCodec = (event: { readonly type: string; readonly [field: string]: unknown }) => Record<string, unknown> | null;

/** What the caller hands the surface. */
export interface WorkerAdapterSurfaceOptions {
  /**
   * This run's emitter. The surface binds the engine's store to it.
   *
   * The emitter instance and not a bare `emit` callback, for the reason
   * `LegacyRunHost.emitter` gives (`run-composition.ts:370-378`): the terminal
   * hold is keyed on the EVENT inside `#mint`, so a callback could be
   * satisfied with a direct stream push and a run would announce success
   * before its durable barrier answered.
   */
  readonly emitter: Pick<RunEventEmitter, 'emit'>;
  /** The worker-side codec. Supplied, not imported -- see the header. */
  readonly legacyFrameCodec: LegacyFrameCodec;
}

/**
 * The worker-channel usage frame the legacy ledger reads.
 *
 * `input_tokens` / `output_tokens` / `total_tokens` are the three the engine
 * actually holds (`engine/run-engine.ts:3263-3270`). The two cache fields are
 * carried only when the payload states them, because inventing `0` would
 * replace a correct absence with a number the provider never reported -- the
 * same reasoning `run-engine-model.ts:165-168` gives for `total_tokens`.
 */
export interface UsageResultFrame {
  readonly type: 'result';
  readonly data: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly cache_hit_tokens?: number;
    readonly cache_creation_tokens?: number;
  };
}

/** The surface plus the one member the declared interface cannot express. */
export interface WorkerAdapter {
  readonly surface: WorkerAdapterSurface;
  /**
   * The `result` frames one `assistant.usage` event projects to.
   *
   * A LIST and not a single frame, because the honest answer for a turn is
   * however many calls the engine can actually account for, and today that is
   * one. A single-frame return would have to either pretend otherwise or
   * encode "one" in its type, and both would be a claim the engine has not
   * made.
   */
  readonly projectUsageResults: (event: RunEvent) => readonly UsageResultFrame[];
}

/**
 * Build the worker adapter's surface.
 *
 * `projectToLegacyFrame` is reached, not copied: this returns a wrapper whose
 * only job is to hand the envelope to the existing projector and pass the
 * verdict through. The wrapper exists because the declared member takes a
 * `RunEvent` while the projector takes a `RunEventEnvelope` -- the envelope is
 * what carries the minted `seq`, and a projection built from a bare `RunEvent`
 * would have no sequence number to be ordered by.
 */
export function createWorkerAdapterSurface(options: WorkerAdapterSurfaceOptions): WorkerAdapter {
  const { emitter, legacyFrameCodec } = options;

  const projectEnvelope = (envelope: RunEventEnvelope): LegacySseFrame | null =>
    projectToLegacyFrame(envelope);

  const projectUsageResults = (event: RunEvent): readonly UsageResultFrame[] => {
    if (event.type !== 'assistant.usage') return [];
    return [toUsageResultFrame(event.usage)];
  };

  return {
    surface: {
      // Reached, not copied: the only thing this wrapper does is hand the
      // envelope to the existing projector and pass the verdict through.
      projectToLegacyFrame: (envelope: RunEventEnvelope) => projectEnvelope(envelope),
      bindEmitter: (store: RunEventStorePort): RunEventStorePort => ({
        // Through the emitter, always -- the same rule and the same ARM the
        // engine's own port builder follows
        // (`packages/agent/src/process/run-engine-ports.ts:888`).
        //
        // `emit`, not `publish`, and the choice is load-bearing rather than
        // stylistic. `RunEventStorePort.publish` is `void`, so the engine cannot
        // await a backpressure signal; `emitter.publish` AWAITS `whenWritable`
        // before it mints (`event-emitter.ts:344`), so binding it here would
        // defer the mint and let a later synchronous `emit` overtake an earlier
        // one -- two events reordered on a port that promises ordering. `emit`
        // is the synchronous arm, and it is the arm production binds.
        publish: (event) => {
          void emitter.emit(event);
        },
        proposeTerminal: (candidate) => store.proposeTerminal(candidate),
        // Forwarded, not re-derived. A surface that rebuilt the store would
        // drop this and take the sub-agent progress frames with it.
        ...(store.projectSubagentProgress === undefined
          ? {}
          : { projectSubagentProgress: store.projectSubagentProgress }),
      }),
      legacyFrameCodec,
    },
    projectUsageResults,
  };
}

/** The one `result` frame an `assistant.usage` payload can honestly produce. */
function toUsageResultFrame(usage: TokenUsage): UsageResultFrame {
  return {
    type: 'result',
    data: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cache_hit_tokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cache_creation_tokens: usage.cacheWriteTokens }),
    },
  };
}
