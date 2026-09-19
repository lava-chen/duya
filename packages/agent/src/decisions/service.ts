/**
 * decisions/service.ts — DecisionService (plan 551 Phase 2).
 *
 * The agent-side decision layer on top of the `DecisionClient`
 * primitive. Responsibilities:
 *
 *   1. Degrade gracefully — ask() walks the chain Jev → LLM
 *      structured-output → throw. Callers catch `DecisionUnavailableError`
 *      and fall back to their own rules; when no client is configured
 *      (no key / disabled) `available` is false and every method is a
 *      no-op, so call sites are byte-identical to pre-plan-551 behavior.
 *   2. Own the question template library (route / risk / verify / done
 *      shapes) so callers express INTENT, not API plumbing.
 *   3. Calibrate — every probability is logged as a (kind, question, p)
 *      record for offline threshold tuning.
 *   4. 419 pre-screen channel (infra, default off) — a risk noul before
 *      tool execution that produces a `suggest_gate` SUGGESTION. It never
 *      changes permission semantics; the bus and the user still decide.
 *
 * Cross-cutting rule (plan 551 §2): the service resolves probabilities
 * through `policy.ts`; gray-band results come back as 'uncertain' and
 * the caller escalates — the service never guesses.
 */

import type { DecisionClient, DecisionRequest, DecisionResponse, Question } from '@duya/ai';
import { CalibrationLogger } from './calibration.js';
import {
  DEFAULT_DECISION_POLICY,
  evaluateNoul,
  topCandidates,
  type DecisionPolicy,
  type NoulVerdict,
} from './policy.js';

/** Thrown when the whole degradation chain fails. Callers fall back to rules. */
export class DecisionUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DecisionUnavailableError';
  }
}

/** A resolved noul plus its policy verdict ('uncertain' inside the gray band). */
export interface ResolvedNoul {
  p: number;
  verdict: NoulVerdict;
}

export interface DecisionServiceOptions {
  /** Primary client (SystemOneClient). Absent → service disabled. */
  client?: DecisionClient;
  /** Second link of the chain (LlmDecisionFallback). */
  fallback?: DecisionClient;
  policy?: DecisionPolicy;
  calibration?: CalibrationLogger;
}

export interface AskOptions {
  /** Caller-known outcome, recorded into the calibration log. */
  outcome?: boolean;
}

export class DecisionService {
  readonly policy: DecisionPolicy;
  private readonly client?: DecisionClient;
  private readonly fallback?: DecisionClient;
  private readonly calibration: CalibrationLogger;

  constructor(options: DecisionServiceOptions) {
    this.client = options.client;
    this.fallback = options.fallback;
    this.policy = options.policy ?? DEFAULT_DECISION_POLICY;
    this.calibration = options.calibration ?? new CalibrationLogger();
  }

  /** False when no backend is configured — every method then no-ops. */
  get available(): boolean {
    return this.client !== undefined || this.fallback !== undefined;
  }

  /**
   * One request, many questions, over the degradation chain. Throws
   * `DecisionUnavailableError` when no backend is configured or every
   * backend fails — the caller's rule path takes over.
   */
  async ask(state: unknown, questions: Record<string, Question>, options?: AskOptions): Promise<DecisionResponse> {
    if (!this.available) {
      throw new DecisionUnavailableError('no decision backend configured');
    }
    let lastError: unknown;
    for (const backend of [this.client, this.fallback]) {
      if (!backend) continue;
      try {
        const res = await backend.decide({ state, questions });
        // Calibrate every probability (confidence for choice/score).
        for (const [id, answer] of Object.entries(res.answers)) {
          const q = questions[id];
          if (answer.kind === 'noul') {
            this.calibration.log('noul', id, answer.p, options?.outcome);
          } else {
            const conf = answer.confidence ?? Object.values(answer.distribution)[0];
            if (typeof conf === 'number') this.calibration.log(q.kind, id, conf, options?.outcome);
          }
        }
        return res;
      } catch (err) {
        lastError = err;
      }
    }
    throw new DecisionUnavailableError(
      `decision chain failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }

  /** Resolve a noul answer through the policy. Throws on unknown question. */
  resolveNoul(response: DecisionResponse, id: string): ResolvedNoul {
    const answer = response.answers[id];
    if (!answer || answer.kind !== 'noul') {
      throw new DecisionUnavailableError(`question "${id}" has no noul answer`);
    }
    return { p: answer.p, verdict: evaluateNoul(answer.p, this.policy) };
  }

  /** Top-k options from a choice answer — for ambiguous escalation. */
  candidates(response: DecisionResponse, id: string, k = 3): Array<{ option: string; p: number }> {
    const answer = response.answers[id];
    if (!answer || answer.kind !== 'choice') return [];
    return topCandidates(answer.distribution, k);
  }

  // ─── Question template library ───

  /** done shape — "is the goal fully reached on this state?" */
  doneQuestion(task: string): Question {
    return {
      kind: 'noul',
      instructions:
        `The overall task is: "${task}". ` +
        'Judging ONLY from the state provided: is the task fully completed right now? ' +
        'Answer no when any required step has not visibly happened.',
    };
  }

  /** error shape — visible failure state. */
  errorQuestion(task: string): Question {
    return {
      kind: 'noul',
      instructions:
        `Task: "${task}". Does the state show an error or failure condition ` +
        '(error message, disabled controls after a failed attempt, crash dialog)?',
    };
  }

  /** blocked shape — a wall the loop cannot pass by itself. */
  blockedQuestion(task: string): Question {
    return {
      kind: 'noul',
      instructions:
        `Task: "${task}". Is progress impossible from this state without outside help ` +
        '(login wall, captcha, permission dialog, missing prerequisite)?',
    };
  }

  /** irreversible shape — the 419/LangChain-AutoMode risk probe. */
  irreversibleQuestion(action: string): Question {
    return {
      kind: 'noul',
      instructions:
        `The next action is: "${action}". Would taking it now be hard or impossible to undo ` +
        '(purchase, payment, send message/email, delete, overwrite data outside this session)? ' +
        'Ordinary clicks, typing and navigation are not irreversible.',
    };
  }

  /** verify shape — supports the 454 Verify→Escalate ladder. */
  verifyQuestion(claim: string): Question {
    return {
      kind: 'noul',
      instructions:
        `Claim to verify from the state alone: "${claim}". ` +
        'How likely is the claim true? Answer no when the state does not show direct evidence.',
    };
  }

  /** route shape — pick one of the caller's labeled routes. */
  routeQuestion(task: string, routes: readonly string[]): Question {
    return {
      kind: 'choice',
      instructions:
        `Task: "${task}". Which route describes the current situation best? ` +
        'Pick exactly one; if none fits, pick the closest.',
      options: routes,
    };
  }
}

/** 419 pre-screen suggestion (infra channel). `suggestion` carries the
 * recommendation; the permission bus remains the sole decision maker. */
export interface PermissionPrescreenSuggestion {
  suggestion: 'gate' | 'pass';
  p: number;
}

/** Pre-screen function shape consumed by the permission gate. */
export type PermissionPrescreener = (
  toolName: string,
  argsPreview: Record<string, unknown>,
) => Promise<PermissionPrescreenSuggestion | null>;

/** Build the pre-screen function the permission gate may consult (default off). */
export function createPermissionPrescreener(
  service: DecisionService,
  enabled: boolean,
): PermissionPrescreener {
  return async (toolName, argsPreview) => {
    if (!enabled || !service.available) return null;
    try {
      const res = await service.ask(
        { tool: toolName, args: argsPreview },
        { risk: service.irreversibleQuestion(`run tool "${toolName}"`) },
      );
      const { p, verdict } = service.resolveNoul(res, 'risk');
      // Suggestion only — logged by the gate; never substitutes for the bus.
      return { suggestion: verdict === 'yes' ? 'gate' : 'pass', p };
    } catch {
      // Pre-screen must never break the permission pipeline.
      return null;
    }
  };
}
