/**
 * Conformance fixtures for the client surface. Shared by the surface model's own
 * suite and by `@duya/agent-runtime`'s legacy-projection suite.
 *
 * ## Why a subpath and not a copy
 *
 * The case table is ~450 lines of per-event setup. It used to live at the top of
 * `agent-runtime/test/surface-conformance.test.ts`, and when `SurfaceModel` moved
 * into this package the suite stayed behind — so the package that now owns the
 * model had **zero tests**, while the coverage everyone cited still pointed at a
 * file in a different package. Copying the helpers would have fixed the
 * ownership and broken it again the next time a fixture changed, in two places.
 *
 * So the fixtures are a declared subpath, mirroring
 * `@duya/agent-protocol/testing`. The model owner and the legacy consumer both
 * import the same table, and a 39th protocol event without a case stays a build
 * error rather than something a reviewer has to notice.
 *
 * ## It is a fixture module, not a test module
 *
 * Nothing here asserts. It builds envelopes around `EVENT_FIXTURES`, which the
 * protocol package holds to its required-field manifest, so every payload here is
 * legal by construction and a failure is always about the surface model.
 */

import type { EventType, RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { EVENT_FIXTURES } from '@duya/agent-protocol/testing';
import { SurfaceModel } from '../surface/surface-model.js';

export const RUN_ID = 'run-conformance';
export const SESSION_ID = 'session-conformance';
export const BASE_TS = 1_700_000_000_000;

/** A legal envelope around the protocol's own minimal fixture payload. */
export function envelope<T extends EventType>(
  type: T,
  overrides: { readonly seq?: number; readonly timestamp?: number; readonly payload?: object } = {},
): RunEventEnvelope<RunEvent & { type: T }> {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seq: overrides.seq ?? 1,
    timestamp: overrides.timestamp ?? BASE_TS,
    traceId: 'trace-conformance',
    payload: { type, ...((EVENT_FIXTURES[type] ?? {}) as object), ...(overrides.payload ?? {}) },
  } as RunEventEnvelope<RunEvent & { type: T }>;
}

/** A fresh run's preamble: `run.started` plus one `turn.started`. */
export function startedModel(): SurfaceModel {
  const model = new SurfaceModel();
  model.apply(envelope('run.started', { seq: 1 }));
  model.apply(envelope('turn.started', { seq: 2 }));
  return model;
}
