import { buildResearchUpdatedEvent } from '@duya/agent-protocol/worker-protocol';
import { sendEvent } from '../../worker-transport.js';
import type { WorkerModeEventEmitter } from '../tool-ports.js';
import { researchModeTracker } from './research-tracker.js';

/** Send the current research card state through the active worker transport. */
export function emitResearchUpdated(sessionId?: string, emit: WorkerModeEventEmitter = sendEvent): void {
  if (!sessionId) return;
  emit(
    buildResearchUpdatedEvent(sessionId, {
      state: researchModeTracker.state(),
      phase: researchModeTracker.phase(),
      query: researchModeTracker.query(),
      subQuestions: researchModeTracker.subQuestions(),
      sourcesGathered: researchModeTracker.sourcesGathered(),
      coverageGaps: researchModeTracker.coverageGaps(),
      rounds: researchModeTracker.rounds(),
      stallRounds: researchModeTracker.stallRounds(),
      history: researchModeTracker.history().map((h) => ({
        at: h.at,
        event: h.event,
        ...(h.detail === undefined ? {} : { detail: h.detail }),
      })),
    }) as unknown as Record<string, unknown>,
  );
}
