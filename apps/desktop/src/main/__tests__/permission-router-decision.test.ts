/**
 * permission-router-decision.test.ts — plan 587 R2.4.
 *
 * `handlePostPermission` had NO duplicate guard and wrote NO durable record. It
 * whitelisted the verb, forwarded the command, and answered `{ ok: true }` for
 * every POST, so a double-click and a stale renderer were indistinguishable from
 * the first answer, and nothing recorded that anyone had decided anything.
 *
 * ## What is exercised, and what is not
 *
 * Exercised: `recordPermissionDecision`, which is the whole of the decision
 * logic the router added. It lives in the control plane rather than in
 * `router.ts` for a testable reason, not a cosmetic one -- `router.ts` deep
 * imports `packages/agent`, and importing it under vitest does not complete.
 *
 * NOT exercised: the HTTP surface. No request is driven through
 * `createHandleRequest`, so "the router really does call this before
 * `sendCommand`" is a source-level claim, pinned in the last block rather than
 * proven end to end. The durable CAS itself is proven in
 * `apps/desktop/src/main/db/toolApprovalState-grant-scope.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { recordPermissionDecision } from '../control-plane/permission-decision-record';

/** A bridge whose CAS behaves like the real `tool_approval_state` store. */
function makeBridge(options: { throwOnResolve?: boolean; notFound?: boolean } = {}) {
  const decided = new Set<string>();
  const calls: Array<Record<string, unknown>> = [];
  const dbRequest = vi.fn(async (action: string, payload: Record<string, unknown>) => {
    if (action !== 'toolApproval:resolve') return undefined;
    if (options.throwOnResolve) throw new Error('SQLITE_BUSY');
    if (options.notFound) return { ok: false, error: 'not_found' };
    calls.push(payload);
    const id = String(payload.id);
    if (decided.has(id)) {
      // A second claim: the row is returned unchanged with claimed: false.
      return { ok: true, claimed: false, row: { id, decision: 'allow' } };
    }
    decided.add(id);
    return { ok: true, claimed: true, row: { id, decision: payload.decision } };
  });
  return { dbRequest, calls, decided };
}

const base = { requestId: 'req-1', sessionId: 'sess-1' } as const;

describe('the decision is recorded before it is delivered', () => {
  it('claims the row on the first answer', async () => {
    const { dbRequest, calls } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'allow' });

    expect(outcome).toEqual({ status: 'recorded', recordedDecision: 'allow' });
    expect(calls).toEqual([{ id: 'req-1', decision: 'allow', sessionId: 'sess-1' }]);
  });

  it('carries the session id onto the write', async () => {
    // The row is scoped by session, so a write without it is unscoped and
    // would answer for whichever session the store happened to be holding.
    const { dbRequest, calls } = makeBridge();
    await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'allow' });

    expect(calls[0].sessionId).toBe('sess-1');
  });

  it('stores a lasting grant as the row vocabulary\'s own word for it', async () => {
    // The column CHECK allows allow/always/deny. Translating silently would be
    // fine here ONLY because the mapping is named, total and in one place.
    const { dbRequest, calls } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, {
      ...base, surface: 'worker_http', decision: 'allow_for_session',
    });

    expect(outcome).toEqual({ status: 'recorded', recordedDecision: 'always' });
    expect(calls[0].decision).toBe('always');
  });

  it('treats allow_once as the one-shot answer it restates', async () => {
    const { dbRequest, calls } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, {
      ...base, surface: 'worker_http', decision: 'allow_once',
    });

    expect(outcome).toEqual({ status: 'recorded', recordedDecision: 'allow' });
  });
});

describe('a late or duplicate answer is a receipt, not a second decision', () => {
  it('reports duplicate and names the decision that is actually on record', async () => {
    const { dbRequest, decided } = makeBridge();
    decided.add('req-1');

    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'allow' });

    expect(outcome).toEqual({ status: 'duplicate', recordedDecision: 'allow' });
  });

  it('a duplicate that contradicts the record does not report itself as the decision', async () => {
    // The row already says `allow`. A later `deny` must not be able to tell a
    // host its refusal was recorded, because it was not.
    const { dbRequest, decided } = makeBridge();
    decided.add('req-1');

    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'deny' });

    expect(outcome.status).toBe('duplicate');
    expect(outcome.status === 'duplicate' && outcome.recordedDecision).toBe('allow');
  });

  it('re-asks the store, and the store is what refuses the second claim', async () => {
    // There is no way to know an answer is a duplicate without asking the thing
    // that holds the record, so the second call DOES happen. What must not
    // happen is a second CLAIM: the CAS is the only thing standing between a
    // double-click and two decisions, which is why it is a store operation and
    // not an in-memory flag.
    const { dbRequest, calls, decided } = makeBridge();
    decided.add('req-1');

    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'allow' });

    expect(calls).toHaveLength(1);
    expect(outcome.status).toBe('duplicate');
  });
});

describe('defer is reachable and records nothing', () => {
  it('is refused as a decision, without touching the store', async () => {
    const { dbRequest, calls } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'defer' });

    expect(outcome).toEqual({ status: 'refused', reason: 'deferred' });
    expect(calls).toHaveLength(0);
  });
});

describe('an unknown action fails closed', () => {
  it('refuses a verb no surface defines, without touching the store', async () => {
    const { dbRequest, calls } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'yes' });

    expect(outcome.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('refuses a bot-card verb offered on the worker surface', async () => {
    // `always` is the bot path's word. Silently accepting it here is how two
    // vocabularies merge by accident rather than by decision.
    const { dbRequest, calls } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'always' });

    expect(outcome.status).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('accepts the bot-card surface\'s own verb when that is the surface', async () => {
    const { dbRequest } = makeBridge();
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'bot_card', decision: 'always' });

    expect(outcome).toEqual({ status: 'recorded', recordedDecision: 'always' });
  });
});

describe('a refused durable write degrades rather than losing the answer', () => {
  it('reports refused when the store throws, so the caller still delivers', async () => {
    // The alternative is a tool call hanging until its deadline because an
    // audit table was locked. A missing audit row is recoverable; a lost answer
    // is not.
    const { dbRequest } = makeBridge({ throwOnResolve: true });
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'allow' });

    expect(outcome).toEqual({ status: 'refused', reason: 'SQLITE_BUSY' });
  });

  it('reports refused when the store has no row, and does not claim it recorded', async () => {
    const { dbRequest } = makeBridge({ notFound: true });
    const outcome = await recordPermissionDecision(dbRequest, { ...base, surface: 'worker_http', decision: 'allow' });

    expect(outcome).toEqual({ status: 'refused', reason: 'not_found' });
  });
});

describe('the router calls this before it forwards (source wiring)', () => {
  const ROUTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'server', 'router.ts');

  it('records the decision before sendCommand', () => {
    const source = readFileSync(ROUTER, 'utf8');
    const record = source.indexOf('recordPermissionDecision(deps.dbRequest');
    const send = source.indexOf('workerManager.sendCommand(sessionId, cmd)', record);

    expect(record).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(record);
  });

  it('does not forward at all when the answer is a duplicate', () => {
    const source = readFileSync(ROUTER, 'utf8');
    const duplicateBranch = source.slice(source.indexOf("durable.status === 'duplicate'"));
    const returns = duplicateBranch.indexOf('return;');

    expect(duplicateBranch).toContain('sendJson(res, 200');
    expect(returns).toBeLessThan(duplicateBranch.indexOf('workerManager.sendCommand'));
  });

  it('takes its verb whitelist from the vocabulary, not an inline list', () => {
    const source = readFileSync(ROUTER, 'utf8');
    expect(source).toContain("acceptedVerbs('worker_http')");
    // The inline array is what let the two vocabularies drift apart silently.
    expect(source).not.toContain("['allow', 'deny', 'allow_once', 'allow_for_session']");
  });
});
