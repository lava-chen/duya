/**
 * A manifest built by the real Control Plane factory, for tests that need one
 * without going through `openRun`.
 *
 * Only the `ExecutionHandle.stop` test needs a manifest directly (everything
 * else goes through `openRun`, which mints its own). Building it here rather
 * than inline keeps the test's import of `@duya/agent-protocol` to a TYPE-only
 * import of `RunManifest`, so this helper adds no value import and therefore no
 * new runtime dependency for the caller.
 */

import type { RunManifest } from '@duya/agent-protocol';
import { buildRunManifest } from '../control-plane/manifest-factory';

export function manifestFor(input: { runId: string; sessionId: string }): RunManifest {
  return buildRunManifest({
    runId: input.runId,
    sessionId: input.sessionId,
    workingDirectory: '/repo',
  }).manifest;
}
