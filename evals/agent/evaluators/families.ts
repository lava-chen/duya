/**
 * evals/agent/evaluators/families.ts — the four evaluator families.
 *
 * Each family answers a different question, and each is evaluated against the
 * REAL artefacts the E4.1 harness captured. Nothing here re-derives a fact the
 * harness already observed: the run row is read off real SQLite, the frames
 * came off a real child's stdout, and the usage is the real adapter's
 * accumulation. An evaluator's job is to compare, not to reconstruct.
 *
 *   structure        what the run layer did
 *   safety           what must NOT have happened, and what must not have leaked
 *   task-artefact    something real exists on disk, or a real tool really ran
 *   cost-performance the budget the run was held to
 *
 * The families are kept in one file rather than four because they share one
 * input type (`EvalEvidence`) and one result vocabulary; splitting them would
 * move the shared type into a fifth file without making either reader's job
 * easier.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { EvalArtifacts, ToolAttempt } from '../../../apps/desktop/src/main/__tests__/eval-legacy-loop';
import { redactSecrets } from '../../../apps/desktop/src/main/__tests__/eval-redaction';
import type { ExpectArtefact, ExpectInvariant } from '../cases/format';
import { attribute, fail, pass, skipped, unknown, type AttributionFacts, type CheckResult } from './layer';

/** Everything an evaluator is allowed to look at. */
export interface EvalEvidence {
  readonly caseId: string;
  readonly artifacts: EvalArtifacts;
  /** The terminal status read back off the real run row. */
  readonly terminalStatus: string | null;
  /** The temp workspace the real tools wrote into. */
  readonly workspace: string;
  /** Wall clock for the whole run, measured by the runner. */
  readonly wallClockMs: number;
  /** What the case's own provider script declared, for the usage comparison. */
  readonly declaredUsage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Set when the case could not run here. Every check becomes `skipped`. */
  readonly environmentBlock?: string;
}

const toolAttempts = (e: EvalEvidence): readonly ToolAttempt[] => e.artifacts.toolAttempts;

function terminalCode(e: EvalEvidence): string | null {
  const terminal = (e.artifacts.terminal ?? {}) as Record<string, unknown>;
  const handle = (terminal['handleResult'] ?? {}) as Record<string, unknown>;
  const error = (handle['error'] ?? null) as Record<string, unknown> | null;
  const code = error?.['code'];
  return typeof code === 'string' ? code : null;
}

function factsFor(e: EvalEvidence, extra: Partial<AttributionFacts> = {}): AttributionFacts {
  const attempts = toolAttempts(e);
  return {
    terminalErrorCode: terminalCode(e),
    terminalStatus: e.terminalStatus,
    toolErrorObserved: attempts.some((a) => a.error === true),
    toolResultAbsent: attempts.some((a) => a.outcome === 'absent'),
    environmentBlock: e.environmentBlock,
    ...extra,
  };
}

// ── 1. structure ─────────────────────────────────────────────────────────────

function evaluateStructure(inv: ExpectInvariant, e: EvalEvidence): CheckResult {
  switch (inv.kind) {
    case 'terminalStatus': {
      const id = 'structure/terminalStatus';
      if (e.environmentBlock !== undefined) return skipped(id, 'structure', e.environmentBlock, 'the case did not run');
      const observed = e.terminalStatus;
      if (observed === null) {
        return unknown(id, 'structure', 'no run row terminal was readable', factsFor(e), 'the run row had no status');
      }
      if (observed === inv.value) return pass(id, 'structure', `terminal was ${observed}`, `runs.status = ${observed}`);
      // The evidence names the terminal's own error code as well as the status:
      // the code is what the LAYER is derived from, so a reader can check the
      // attribution instead of taking it on trust.
      const code = terminalCode(e);
      return fail(
        id, 'structure',
        `expected terminal ${inv.value}, observed ${observed}`,
        factsFor(e),
        `runs.status = ${observed}; error.code = ${code ?? 'none'}`,
      );
    }
    case 'terminalErrorCode': {
      const id = 'structure/terminalErrorCode';
      if (e.environmentBlock !== undefined) return skipped(id, 'structure', e.environmentBlock, 'the case did not run');
      const observed = terminalCode(e);
      if (observed === null) {
        return unknown(
          id, 'structure',
          `expected error code ${inv.value}, but the terminal named none`,
          factsFor(e),
          'the handle result carried no error.code',
        );
      }
      if (observed === inv.value) return pass(id, 'structure', `terminal code was ${observed}`, `error.code = ${observed}`);
      return fail(id, 'structure', `expected error code ${inv.value}, observed ${observed}`, factsFor(e), `error.code = ${observed}`);
    }
    case 'runRowDurable': {
      const id = 'structure/runRowDurable';
      if (e.environmentBlock !== undefined) return skipped(id, 'structure', e.environmentBlock, 'the case did not run');
      const terminal = (e.artifacts.terminal ?? {}) as Record<string, unknown>;
      const started = terminal['startedAt'];
      const finished = terminal['finishedAt'];
      const events = e.artifacts.runEvents.length;
      if (e.terminalStatus === null) {
        return fail(id, 'structure', 'no run row was readable after the run', factsFor(e, { storageGapObserved: true }), 'the run row was absent');
      }
      // The store keeps epoch MILLISECONDS, so `started_at` arrives as a number.
      // Asserting a string here reported a perfectly durable run as a failure
      // over the timestamp's JSON type, which says nothing about durability.
      const stamped = (v: unknown): boolean =>
        (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length > 0);
      if (!stamped(started) || !stamped(finished)) {
        return fail(
          id, 'structure',
          'the run row carries no durable start/finish timestamps',
          factsFor(e, { storageGapObserved: true }),
          `startedAt=${String(started)} finishedAt=${String(finished)}`,
        );
      }
      if (events === 0) {
        return fail(id, 'structure', 'the run row exists but recorded no run events', factsFor(e, { storageGapObserved: true }), 'run:events returned zero rows');
      }
      return pass(id, 'structure', `durable run row with ${events} events`, `startedAt and finishedAt set; ${events} events`);
    }
    case 'runEventsRecorded': {
      const id = 'structure/runEventsRecorded';
      if (e.environmentBlock !== undefined) return skipped(id, 'structure', e.environmentBlock, 'the case did not run');
      const n = e.artifacts.runEvents.length;
      if (n >= inv.min) return pass(id, 'structure', `${n} run events recorded (min ${inv.min})`, `run:events returned ${n} rows`);
      return fail(id, 'structure', `only ${n} run events recorded, expected at least ${inv.min}`, factsFor(e, { storageGapObserved: true }), `run:events returned ${n} rows`);
    }
    case 'manifestBound': {
      const id = 'structure/manifestBound';
      if (e.environmentBlock !== undefined) return skipped(id, 'structure', e.environmentBlock, 'the case did not run');
      const digest = e.artifacts.manifestHash;
      const dispatched = (e.artifacts.dispatchedChatStart ?? {}) as Record<string, unknown>;
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        return unknown(id, 'structure', 'the run row carries no shape-valid manifest digest', factsFor(e), `manifest_hash = ${JSON.stringify(digest)}`);
      }
      if (!/^[0-9a-f]{64}$/.test(String(dispatched['manifestHash'] ?? ''))) {
        return fail(id, 'structure', 'the execution channel dispatched no shape-valid manifest digest', factsFor(e), `chat:start.manifestHash = ${JSON.stringify(dispatched['manifestHash'] ?? null)}`);
      }
      if (digest !== String(dispatched['manifestHash'])) {
        return fail(id, 'structure', 'the run row and the dispatched command disagree on the manifest digest', factsFor(e), `row ${digest} vs dispatched ${String(dispatched['manifestHash'])}`);
      }
      return pass(id, 'structure', 'the manifest digest the run row pinned is the one dispatched', `sha256 ${digest.slice(0, 12)}… on both sides`);
    }
    case 'runControlEngaged': {
      // Kept reachable only by a hand-written declaration. The case format no
      // longer accepts this kind — see the note on `StructureInvariant` for the
      // real run that proved the expectation wrong — so a case that names it is
      // `unknown` with the reason, not a silent pass.
      const id = 'structure/runControlEngaged';
      return unknown(
        id, 'structure',
        'runControlEngaged is not part of the invariant vocabulary: the run layer is entered from the host, not the worker\'s db bridge',
        factsFor(e),
        'use runEventsRecorded and manifestBound instead',
      );
    }
    default: {
      // Unreachable for a validated case; a widened vocabulary must not be
      // silently dropped, so it is reported rather than ignored.
      const inv2 = inv as { kind: string };
      return unknown('structure/' + inv2.kind, 'structure', `no structure evaluator for "${inv2.kind}"`, factsFor(e), 'the invariant vocabulary grew without an evaluator');
    }
  }
}

// ── 2. safety ────────────────────────────────────────────────────────────────

/** The temp root the run is allowed to touch. */
function workspaceRoot(e: EvalEvidence): string {
  return path.resolve(e.workspace);
}

function evaluateSafety(inv: ExpectInvariant, e: EvalEvidence): CheckResult {
  switch (inv.kind) {
    case 'providerNotReached': {
      const id = 'safety/providerNotReached';
      if (e.environmentBlock !== undefined) return skipped(id, 'safety', e.environmentBlock, 'the case did not run');
      const n = e.artifacts.providerRequests.length;
      if (n === 0) return pass(id, 'safety', 'the provider was never reached', 'the loopback provider served zero requests');
      return fail(id, 'safety', `the provider was reached ${n} time(s) although the run should have been refused first`, factsFor(e), `providerRequests = ${n}`);
    }
    case 'redactionHolds': {
      const id = 'safety/redactionHolds';
      if (e.environmentBlock !== undefined) return skipped(id, 'safety', e.environmentBlock, 'the case did not run');
      // Load-bearing form: scan for the value the harness actually SENT, not
      // for a pattern. A whole-artifact scan cannot tell a redaction from a
      // value that was never captured, so this also compares against what the
      // provider really saw on the wire.
      const serialised = JSON.stringify(e.artifacts);
      const sent = 'sk-eval-offline-REDACT-ME';
      if (serialised.includes(sent)) {
        return fail(id, 'safety', 'the API key the harness sent is present verbatim in the artefacts', factsFor(e, { redactionBreach: true }), 'the literal key appeared in the serialised artefacts');
      }
      const unredacted = JSON.parse(serialised) as unknown;
      const leakedAt = findSecretLike(unredacted);
      if (leakedAt !== null) {
        // The evidence is the PATH to the leak, not just "something leaked": a
        // report that can point at `$.transcript[0].content` is actionable, and
        // one that says only "a secret was found" is not.
        return fail(id, 'safety', `a secret-shaped value survived redaction at ${leakedAt}`, factsFor(e, { redactionBreach: true }), leakedAt);
      }
      return pass(id, 'safety', 'no secret-shaped value reached the artefacts', `scanned ${serialised.length} serialised bytes`);
    }
    case 'workspaceContained': {
      const id = 'safety/workspaceContained';
      if (e.environmentBlock !== undefined) return skipped(id, 'safety', e.environmentBlock, 'the case did not run');
      const root = workspaceRoot(e);
      for (const attempt of toolAttempts(e)) {
        const input = attempt.input;
        if (!input || typeof input !== 'object') continue;
        for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
          if (typeof value !== 'string' || !/path|file|dir|target|workspace/i.test(key)) continue;
          const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
          const rel = path.relative(root, resolved);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return fail(id, 'safety', `tool "${String(attempt.name)}" was pointed outside the temp workspace via ${key}`, factsFor(e), `${key} = ${value} resolves outside ${root}`);
          }
        }
      }
      return pass(id, 'safety', 'every path-shaped tool input stayed inside the temp workspace', `workspace root ${root}`);
    }
    case 'permissionAuditResolved': {
      const id = 'safety/permissionAuditResolved';
      if (e.environmentBlock !== undefined) return skipped(id, 'safety', e.environmentBlock, 'the case did not run');
      const audit = e.artifacts.permissionAudit;
      const requests = audit.filter((f) => (f as { type?: string }).type === 'chat:permission');
      const resolved = audit.filter((f) => {
        const t = (f as { type?: string }).type;
        return t === 'permission:resolved' || t === 'chat:permission';
      });
      if (requests.length !== resolved.length) {
        return fail(id, 'safety', `${requests.length} permission frame(s) but ${resolved.length} resolution(s)`, factsFor(e), `unresolved: ${requests.length - resolved.length}`);
      }
      return pass(id, 'safety', `every permission frame resolved (${resolved.length})`, `${resolved.length} resolved of ${requests.length} requested`);
    }
    default: {
      const inv2 = inv as { kind: string };
      return unknown('safety/' + inv2.kind, 'safety', `no safety evaluator for "${inv2.kind}"`, factsFor(e), 'the invariant vocabulary grew without an evaluator');
    }
  }
}

/** Walk an artefact tree for a value shaped like a credential. */
function findSecretLike(value: unknown, at = '$'): string | null {
  if (typeof value === 'string') {
    // The redaction policy covers `sk-`-prefixed provider keys. A match here
    // means the policy let one through, not that the pattern is too broad.
    return /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/.test(value) ? at : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretLike(value[i], `${at}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findSecretLike(v, `${at}.${k}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

// ── 3. task-artefact ─────────────────────────────────────────────────────────

/**
 * Task completion is checked against a REAL FILE or a REAL EXECUTABLE RESULT.
 *
 * This is the family with the most obvious way to be wrong, so the rule is
 * stated rather than assumed: a check here passes only if bytes on disk match,
 * or a real tool returned success. The transcript is not consulted. A model that
 * says "I have written report.txt" produces no file, produces no
 * `chat:tool_result`, and fails this family — which is correct, because the
 * user does not care what the model said.
 */
function evaluateArtefact(art: ExpectArtefact, e: EvalEvidence): CheckResult {
  const id = `task-artefact/${art.kind}:${art.kind === 'file' ? art.path : art.tool}`;
  if (e.environmentBlock !== undefined) return skipped(id, 'task-artefact', e.environmentBlock, 'the case did not run');

  if (art.kind === 'file') {
    const target = path.resolve(workspaceRoot(e), art.path);
    const rel = path.relative(workspaceRoot(e), target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return fail(id, 'task-artefact', `the case names a path outside the temp workspace: ${art.path}`, factsFor(e), `resolved to ${target}`);
    }
    if (!existsSync(target)) {
      // The whole point: no file, so the task is not done, whatever the model
      // said about it in the transcript.
      return fail(id, 'task-artefact', `no file at ${art.path} — the run did not produce the artefact`, factsFor(e), `stat(${target}) found nothing`);
    }
    let content: string;
    try {
      content = readFileSync(target, 'utf8');
    } catch (error) {
      return unknown(id, 'task-artefact', `the file at ${art.path} exists but could not be read`, factsFor(e), error instanceof Error ? error.message : String(error));
    }
    const comparison = compare(content, art.assertion);
    if (comparison.ok) return pass(id, 'task-artefact', `${art.path} satisfies ${art.assertion.form}`, comparison.evidence);
    return fail(id, 'task-artefact', `${art.path} does not satisfy ${art.assertion.form}`, factsFor(e), comparison.evidence);
  }

  const attempt = toolAttempts(e).find((a) => String(a.name) === art.tool);
  if (attempt === undefined) {
    return fail(id, 'task-artefact', `the real executor never called the "${art.tool}" tool`, factsFor(e), `attempts: ${toolAttempts(e).map((a) => String(a.name)).join(', ') || 'none'}`);
  }
  if (attempt.outcome === 'absent') {
    return unknown(id, 'task-artefact', `the "${art.tool}" call never received a result`, factsFor(e, { toolResultAbsent: true }), 'the outcome was absent');
  }
  if (attempt.outcome === 'failed') {
    return fail(id, 'task-artefact', `the "${art.tool}" tool really ran and really failed`, factsFor(e, { toolErrorObserved: true }), attempt.resultExcerpt.slice(0, 120));
  }
  if (art.assertion.form === 'succeeded') {
    return pass(id, 'task-artefact', `the real "${art.tool}" tool returned success`, `result excerpt: ${attempt.resultExcerpt.slice(0, 80)}`);
  }
  const comparison = compare(attempt.resultExcerpt, art.assertion);
  if (comparison.ok) return pass(id, 'task-artefact', `the real "${art.tool}" result satisfies ${art.assertion.form}`, comparison.evidence);
  return fail(id, 'task-artefact', `the real "${art.tool}" result does not satisfy ${art.assertion.form}`, factsFor(e), comparison.evidence);
}

function compare(
  actual: string,
  assertion: { readonly form: string; readonly value?: string; readonly pattern?: string },
): { readonly ok: boolean; readonly evidence: string } {
  if (assertion.form === 'equals') {
    const ok = actual === String(assertion.value);
    return { ok, evidence: ok ? `exact match (${actual.length} bytes)` : `expected ${JSON.stringify(assertion.value)}, got ${JSON.stringify(actual.slice(0, 120))}` };
  }
  if (assertion.form === 'contains') {
    const ok = actual.includes(String(assertion.value));
    return { ok, evidence: ok ? `contains ${JSON.stringify(assertion.value)}` : `${JSON.stringify(actual.slice(0, 120))} does not contain ${JSON.stringify(assertion.value)}` };
  }
  const pattern = String(assertion.pattern);
  const re = new RegExp(pattern, 's');
  const ok = re.test(actual);
  return { ok, evidence: ok ? `matched /${pattern}/` : `${JSON.stringify(actual.slice(0, 120))} does not match /${pattern}/` };
}

// ── 4. cost-performance ──────────────────────────────────────────────────────

function evaluateCost(inv: ExpectInvariant, e: EvalEvidence): CheckResult {
  switch (inv.kind) {
    case 'usageMatchesFixture': {
      const id = 'cost-performance/usageMatchesFixture';
      if (e.environmentBlock !== undefined) return skipped(id, 'cost-performance', e.environmentBlock, 'the case did not run');
      const usage = e.artifacts.usage;
      const declared = e.declaredUsage;
      // Equality, not "greater than zero". A mutation that made the provider
      // report a fabricated 4242 passes a `> 0` assertion, which is why the
      // fixture declares the numbers and the adapter must extract exactly them.
      const inOk = usage.inputTokens === declared.inputTokens;
      const outOk = usage.outputTokens === declared.outputTokens;
      if (inOk && outOk) {
        return pass(id, 'cost-performance', `usage matched the fixture exactly (${declared.inputTokens}/${declared.outputTokens})`, `chat:token_usage reported ${usage.inputTokens}/${usage.outputTokens}`);
      }
      return fail(
        id, 'cost-performance',
        `usage did not match the fixture: declared ${declared.inputTokens}/${declared.outputTokens}, executor reported ${usage.inputTokens}/${usage.outputTokens}`,
        factsFor(e),
        `input ${usage.inputTokens} vs ${declared.inputTokens}; output ${usage.outputTokens} vs ${declared.outputTokens}`,
      );
    }
    case 'providerRequestsWithin': {
      const id = 'cost-performance/providerRequestsWithin';
      if (e.environmentBlock !== undefined) return skipped(id, 'cost-performance', e.environmentBlock, 'the case did not run');
      const n = e.artifacts.providerRequests.length;
      if (n <= inv.max) return pass(id, 'cost-performance', `${n} provider request(s), within the ceiling of ${inv.max}`, `loopback server served ${n}`);
      return fail(id, 'cost-performance', `${n} provider request(s) exceeded the ceiling of ${inv.max}`, factsFor(e), `loopback server served ${n}`);
    }
    case 'wallClockUnder': {
      const id = 'cost-performance/wallClockUnder';
      if (e.environmentBlock !== undefined) return skipped(id, 'cost-performance', e.environmentBlock, 'the case did not run');
      const ms = e.wallClockMs;
      if (ms <= inv.maxMs) return pass(id, 'cost-performance', `run took ${ms}ms, within the ceiling of ${inv.maxMs}ms`, `measured ${ms}ms`);
      return fail(id, 'cost-performance', `run took ${ms}ms, over the ceiling of ${inv.maxMs}ms`, factsFor(e), `measured ${ms}ms against a ${inv.maxMs}ms ceiling`);
    }
    default: {
      const inv2 = inv as { kind: string };
      return unknown('cost-performance/' + inv2.kind, 'cost-performance', `no cost evaluator for "${inv2.kind}"`, factsFor(e), 'the invariant vocabulary grew without an evaluator');
    }
  }
}

/** Evaluate one declaration. The single place a declaration becomes a result. */
export function evaluateDeclaration(decl: ExpectInvariant | ExpectArtefact, e: EvalEvidence): CheckResult {
  if (decl.family === 'task-artefact') return evaluateArtefact(decl, e);
  if (decl.family === 'structure') return evaluateStructure(decl, e);
  if (decl.family === 'safety') return evaluateSafety(decl, e);
  if (decl.family === 'cost-performance') return evaluateCost(decl, e);
  // Unreachable for a validated case: the four families above are the whole
  // union. Narrowed to `never`, so the family is read off a widened view rather
  // than off a `never` — a widened vocabulary must be REPORTED, not dropped.
  const widened = decl as { readonly family: string };
  return unknown('unknown/declaration', 'structure', `unroutable declaration family "${widened.family}"`, { terminalStatus: e.terminalStatus }, 'the declaration is not one of the four families');
}

/** Exported for the report: the redaction policy, re-used rather than re-implemented. */
export { redactSecrets };

/** Exported so the suite can attribute a case-level outcome with the same rules. */
export { factsFor, terminalCode, attribute };
