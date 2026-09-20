/**
 * decisions/calibration.ts — (probability, outcome) calibration log
 * (plan 551 Phase 2).
 *
 * Jev cannot explain itself — the ONLY debugging instrument is the
 * per-round probability log (jev research §3.4). Every decision the
 * service makes is recorded here with its probability and, when it
 * becomes known, the outcome. Thresholds (`doneAt` / `irreversibleAt`)
 * are then recalibrated offline from these records — the jev-browser
 * "Next steps" list calls for exactly this loop.
 *
 * Records go to the structured agent logger (DEBUG level, component
 * 'decisions') so file logs stay greppable without polluting the
 * console at the default WARN level.
 */

import { logger } from '../utils/logger.js';

export const DECISIONS_LOG_COMPONENT = 'decisions';

/** One calibration observation. */
export interface CalibrationRecord {
  /** Decision kind. */
  kind: 'choice' | 'score' | 'noul';
  /** Question id / template name (e.g. 'done', 'irreversible', 'target'). */
  question: string;
  /** The model's probability (noul) or confidence (choice/score). */
  probability: number;
  /**
   * Ground truth when the caller knows it (e.g. the action the user
   * actually approved, the task that actually finished). Absent while
   * the outcome is still pending.
   */
  outcome?: boolean;
  /** ISO timestamp. */
  ts: string;
}

/** Sink seam for tests; production writes through the agent logger. */
export interface CalibrationSink {
  append(record: CalibrationRecord): void;
}

class LoggerCalibrationSink implements CalibrationSink {
  append(record: CalibrationRecord): void {
    logger.debug('decision:calibration', { ...record }, DECISIONS_LOG_COMPONENT);
  }
}

/**
 * Append-only calibration logger. Cheap enough to call on every
 * decision round; records are one line each.
 */
export class CalibrationLogger {
  private readonly sink: CalibrationSink;

  constructor(sink: CalibrationSink = new LoggerCalibrationSink()) {
    this.sink = sink;
  }

  log(kind: CalibrationRecord['kind'], question: string, probability: number, outcome?: boolean): void {
    this.sink.append({
      kind,
      question,
      probability,
      outcome,
      ts: new Date().toISOString(),
    });
  }

  /** Record the outcome of a previously logged probability (same id). */
  logOutcome(kind: CalibrationRecord['kind'], question: string, probability: number, outcome: boolean): void {
    this.log(kind, question, probability, outcome);
  }
}
