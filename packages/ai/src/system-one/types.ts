/**
 * system-one/types.ts — typed decision contracts (plan 551 Phase 1).
 *
 * Jev ("System One" model, TypeSafe 2026-09-16) is NOT a chat model: it
 * never generates free text. One request carries a state plus a batch of
 * questions; the server evaluates them in parallel and returns typed
 * decisions with calibrated probabilities:
 *
 *   - `choice` — pick one option from a caller-provided candidate list.
 *     Returns the chosen option, the probability distribution and an
 *     overall confidence.
 *   - `score`  — probability-weighted position along ordered levels.
 *     Returns a continuous value, the distribution and a confidence.
 *   - `noul`   — P(yes) for a proposition. No separate confidence: 0.5
 *     means "even odds", not "medium strength".
 *
 * Design rules that shape these types (jev-browser / plan 551 §2):
 *   - Jev decides, never generates — every candidate comes from the caller.
 *   - One request per round, many questions — batching is free, splitting
 *     calls is not.
 *   - Cardinality cap 255 (official) — enforced here before the wire.
 *   - Typed output guarantees the interface, not truth — callers must
 *     treat probabilities as policy inputs, never as licenses.
 */

/** The three System One decision primitives. */
export type DecisionKind = 'choice' | 'score' | 'noul';

/** Official cardinality cap for questions per request and options per choice. */
export const MAX_CARDINALITY = 255;

export interface ChoiceQuestion {
  kind: 'choice';
  /**
   * Full semantics of the question. Question IDs are NOT sent to the
   * model (per official guidance) — the instructions carry the meaning.
   */
  instructions: string;
  /** Candidate options in stable order. The model cannot pick what is absent. */
  options: readonly string[];
}

export interface ScoreQuestion {
  kind: 'score';
  instructions: string;
  /** Ordered level labels (low → high), 2..255 entries. */
  levels: readonly string[];
}

export interface NoulQuestion {
  kind: 'noul';
  instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface DecisionRequest {
  /** Unstructured or structured state the questions evaluate against. */
  state: unknown;
  /** Question id → question. All questions are evaluated in one request. */
  questions: Record<string, Question>;
}

/** Answer to a `choice` question. */
export interface ChoiceAnswer {
  kind: 'choice';
  /** The chosen option string (must be one of the offered options). */
  value: string;
  /** Probability distribution over the offered options. */
  distribution: Record<string, number>;
  /** Overall confidence (how concentrated the distribution is). */
  confidence?: number;
}

/** Answer to a `score` question. */
export interface ScoreAnswer {
  kind: 'score';
  /** Probability-weighted position along the levels (continuous). */
  value: number;
  distribution: Record<string, number>;
  confidence?: number;
}

/** Answer to a `noul` question — plain P(yes). No separate confidence. */
export interface NoulAnswer {
  kind: 'noul';
  /** P(yes), 0..1. */
  p: number;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface DecisionResponse {
  /** Question id → answer, mirroring the request's question ids. */
  answers: Record<string, DecisionAnswer>;
}

/** Error thrown when the wire response fails validation. */
export class DecisionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionProtocolError';
  }
}

/** Validate a request against the cardinality + shape rules. Throws on violation. */
export function validateDecisionRequest(request: DecisionRequest): void {
  const ids = Object.keys(request.questions);
  if (ids.length === 0) {
    throw new DecisionProtocolError('decision request carries no questions');
  }
  if (ids.length > MAX_CARDINALITY) {
    throw new DecisionProtocolError(
      `too many questions (${ids.length} > ${MAX_CARDINALITY}) — split the request`,
    );
  }
  for (const id of ids) {
    const q = request.questions[id];
    if (!q || typeof q.instructions !== 'string' || q.instructions.length === 0) {
      throw new DecisionProtocolError(`question "${id}" is missing instructions`);
    }
    if (q.kind === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        throw new DecisionProtocolError(`choice question "${id}" needs at least 2 options`);
      }
      if (q.options.length > MAX_CARDINALITY) {
        throw new DecisionProtocolError(
          `choice question "${id}" has ${q.options.length} options (cap ${MAX_CARDINALITY})`,
        );
      }
    }
    if (q.kind === 'score') {
      if (!Array.isArray(q.levels) || q.levels.length < 2) {
        throw new DecisionProtocolError(`score question "${id}" needs at least 2 levels`);
      }
      if (q.levels.length > MAX_CARDINALITY) {
        throw new DecisionProtocolError(
          `score question "${id}" has ${q.levels.length} levels (cap ${MAX_CARDINALITY})`,
        );
      }
    }
  }
}
