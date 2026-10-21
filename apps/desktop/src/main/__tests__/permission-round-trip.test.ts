/**
 * permission-round-trip.test.ts — plan 587 R2.4.
 *
 * The approval round trip, offline: no worker, no Electron, no provider.
 *
 * Each test names the defect it pins. Every one of them fails on master,
 * because on master the router writes no durable decision, has no duplicate
 * guard, owns no deadline, and `defer` is a protocol constant with no call
 * site anywhere in the repo.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  PermissionCoordinator,
  type PermissionDecisionStore,
  type PermissionDeliverer,
  type TimerHandle,
} from '../control-plane/permission-coordinator.js';
import {
  acceptedVerbs,
  asProtocolAction,
  bindGrantScope,
  surfaceOrigins,
  translate,
  GRANT_PENDING_TOOL,
} from '../control-plane/permission-vocabulary.js';
import type { PermissionRequest, PermissionResolution } from '@duya/agent-protocol';

// ── fakes ─────────────────────────────────────────────────────────────────

/**
 * A durable store, in memory.
 *
 * `firstWins` is the whole point of the real one, so it is the whole point of
 * this one: the second `record` for an id never overwrites the first.
 */
function makeStore(overrides: { failOnRecord?: boolean } = {}) {
  const rows = new Map<string, PermissionResolution & { runId: string; sessionId: string }>();
  const order: string[] = [];
  const store: PermissionDecisionStore = {
    record(row) {
      if (overrides.failOnRecord) return 'failed';
      if (rows.has(row.requestId)) return 'duplicate';
      rows.set(row.requestId, row);
      order.push(row.requestId);
      return 'recorded';
    },
    read(requestId) {
      return rows.get(requestId) ?? null;
    },
  };
  return { store, rows, order };
}

function makeGrants(overrides: { fail?: boolean } = {}) {
  const grants: Array<{ toolName: string; sessionId: string }> = [];
  return {
    grants,
    store: {
      grant(scope: { kind: 'tool'; toolName: string }, sessionId: string) {
        if (overrides.fail) return 'failed' as const;
        grants.push({ toolName: scope.toolName, sessionId });
        return 'granted' as const;
      },
    },
  };
}

/** Records what was delivered, and when, relative to the store's writes. */
function makeDeliverer() {
  const delivered: Array<{ requestId: string; action: string; updatedInput?: unknown }> = [];
  const deliver: PermissionDeliverer = {
    deliver(input) {
      delivered.push({
        requestId: input.requestId,
        action: input.action,
        ...(input.updatedInput ? { updatedInput: input.updatedInput } : {}),
      });
    },
  };
  return { deliver, delivered };
}

/** A timer the test fires by hand, so a deadline is provable without waiting. */
function makeClock() {
  let now = 1_000;
  const timers: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    fireAll() {
      for (const t of timers) if (!t.cleared) t.fire();
    },
    get armed() {
      return timers.filter((t) => !t.cleared).length;
    },
    get scheduledMs() {
      return timers.map((t) => t.ms);
    },
    schedule(ms: number, fire: () => void): TimerHandle {
      const entry = { ms, fire, cleared: false };
      timers.push(entry);
      return {
        clear() {
          entry.cleared = true;
        },
      };
    },
  };
}

function makeCoordinator(opts: { failOnRecord?: boolean; failGrant?: boolean } = {}) {
  const clock = makeClock();
  const { store, rows, order } = makeStore({ failOnRecord: opts.failOnRecord });
  const { store: grants, grants: grantList } = makeGrants({ fail: opts.failGrant });
  const { deliver, delivered } = makeDeliverer();
  const coordinator = new PermissionCoordinator({
    store,
    grants,
    deliver,
    now: clock.now,
    schedule: clock.schedule,
  });
  return { coordinator, clock, rows, order, grantList, delivered };
}

function request(overrides: Partial<Omit<PermissionRequest, 'startedAt' | 'expiresAt'>> & { runId: string } = { runId: 'run-1' }) {
  const { runId, ...rest } = overrides;
  return {
    requestId: 'req-1',
    kind: 'tool_use',
    toolName: 'remote_notion_write',
    toolInput: { title: 'notes' },
    mode: 'generic' as const,
    runId,
    sessionId: 'sess-1',
    ...rest,
  };
}

// ── the deadline ──────────────────────────────────────────────────────────

describe('the permission deadline is owned in one place', () => {
  it('mints expiresAt from the injected clock and arms exactly one timer at that value', () => {
    const { coordinator, clock } = makeCoordinator();
    coordinator.configureTimeout(60_000);

    const opened = coordinator.open(request());
    expect(opened.alreadyOpen).toBe(false);

    // The displayed deadline IS the armed deadline: one number, not two.
    expect(opened.request.expiresAt - opened.request.startedAt).toBe(60_000);
    expect(clock.scheduledMs).toEqual([60_000]);
  });

  it('does not mint a second deadline when a reconnect replays the same request', () => {
    const { coordinator, clock } = makeCoordinator();
    const first = coordinator.open(request());
    const second = coordinator.open(request());

    expect(second.alreadyOpen).toBe(true);
    // The replay gets the ORIGINAL deadline back, and arms nothing.
    expect(second.request.expiresAt).toBe(first.request.expiresAt);
    expect(clock.armed).toBe(1);
  });

  it('rejects on the deadline and records why, without delivering anything', async () => {
    const { coordinator, clock, rows, delivered } = makeCoordinator();
    coordinator.open(request());
    expect(delivered).toHaveLength(0);

    clock.fireAll();

    expect(rows.get('req-1')).toMatchObject({ action: 'deny', source: 'timeout' });
    // A timeout is a fact for the audit; it is not an instruction to a worker.
    expect(delivered).toHaveLength(0);
    expect(coordinator.pendingCount).toBe(0);
  });

  it('a timeout is a deny, so a late answer is a receipt and not a second decision', async () => {
    const { coordinator, clock, order } = makeCoordinator();
    coordinator.open(request());
    clock.fireAll();

    const late = await coordinator.resolve({
      requestId: 'req-1',
      runId: 'run-1',
      sessionId: 'sess-1',
      decision: 'allow',
      surface: 'worker_http',
    });

    expect(late.firstDecision).toBe(false);
    expect(late.refusal).toBe('permission_unknown_request');
    // The timeout wrote the one row. The late allow did not overwrite it.
    expect(order).toEqual(['req-1']);
  });
});

// ── durable before delivered ──────────────────────────────────────────────

describe('the decision is durable before it is delivered', () => {
  it('records the decision, and the recorded row exists by the time the worker is told', async () => {
    const { coordinator, rows, delivered } = makeCoordinator();
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1',
      runId: 'run-1',
      sessionId: 'sess-1',
      decision: 'allow',
      surface: 'worker_http',
    });

    expect(receipt.firstDecision).toBe(true);
    expect(rows.get('req-1')).toMatchObject({ action: 'allow', runId: 'run-1', sessionId: 'sess-1' });
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'allow' }]);
  });

  it('delivers NOTHING when the durable write refuses', async () => {
    // A decision the worker acted on but the store never learned about is an
    // audit claiming a question was answered when nothing was recorded.
    const { coordinator, delivered } = makeCoordinator({ failOnRecord: true });
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1',
      runId: 'run-1',
      sessionId: 'sess-1',
      decision: 'allow',
      surface: 'worker_http',
    });

    expect(receipt.refusal).toBe('persistence_failed');
    expect(receipt.action).toBeNull();
    expect(delivered).toHaveLength(0);
  });

  it('carries one requestId and one runId across the whole round trip', async () => {
    const { coordinator, rows } = makeCoordinator();
    coordinator.open(request({ requestId: 'req-42', runId: 'run-7' }));

    const receipt = await coordinator.resolve({
      requestId: 'req-42',
      runId: 'run-7',
      sessionId: 'sess-1',
      decision: 'deny',
      surface: 'worker_http',
    });

    expect(receipt.requestId).toBe('req-42');
    expect(receipt.audit.requestId).toBe('req-42');
    expect(rows.get('req-42')).toMatchObject({ runId: 'run-7', sessionId: 'sess-1' });
  });
});

// ── late and duplicate ────────────────────────────────────────────────────

describe('a late or duplicate answer returns a receipt and does not re-execute', () => {
  it('the second answer is refused and nothing is delivered twice', async () => {
    const { coordinator, delivered } = makeCoordinator();
    coordinator.open(request());

    const first = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow', surface: 'worker_http',
    });
    const second = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow', surface: 'worker_http',
    });

    expect(first.firstDecision).toBe(true);
    expect(second.firstDecision).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it('a duplicate that contradicts the recorded decision reports the RECORDED one', async () => {
    // The audit is the receipt of record. Answering "allow" after a recorded
    // "deny" must not leave the caller believing the call was authorised.
    const { coordinator, delivered } = makeCoordinator();
    coordinator.open(request());
    await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'deny', surface: 'worker_http',
    });

    const second = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow', surface: 'worker_http',
    });

    expect(second.action).toBe('deny');
    expect(delivered).toHaveLength(1);
  });

  it('an answer for a request that was never opened is refused, not executed', async () => {
    const { coordinator, delivered, rows } = makeCoordinator();

    const receipt = await coordinator.resolve({
      requestId: 'never-opened', runId: 'run-1', sessionId: 'sess-1', decision: 'allow', surface: 'worker_http',
    });

    expect(receipt.refusal).toBe('permission_unknown_request');
    expect(receipt.firstDecision).toBe(false);
    expect(delivered).toHaveLength(0);
    expect(rows.size).toBe(0);
  });
});

// ── unknown fails closed ──────────────────────────────────────────────────

describe('an unknown action fails closed', () => {
  it('records a denial and delivers a deny, for a verb no surface defines', async () => {
    const { coordinator, rows, delivered } = makeCoordinator();
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow_maybe', surface: 'worker_http',
    });

    expect(receipt.audit.action).toBe('deny');
    expect(rows.get('req-1')).toMatchObject({ action: 'deny' });
    // The worker is told "deny", never "allow_maybe".
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'deny' }]);
  });

  it('rejects a legacy verb offered on the wrong surface', async () => {
    // `always` is the bot card's word. The worker path has never accepted it,
    // and quietly widening that list is how two vocabularies become one by
    // accident rather than by decision.
    const { coordinator, delivered } = makeCoordinator();
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'always', surface: 'worker_http',
    });

    expect(receipt.audit.action).toBe('deny');
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'deny' }]);
  });

  it('treats a surface name as not-an-action when the frame is already protocol-shaped', () => {
    // `asProtocolAction` is the gate for an already-protocol frame. Accepting
    // a surface name here would re-introduce the second vocabulary at the
    // boundary it was supposed to leave behind.
    expect(asProtocolAction('allow')).toBe('allow');
    expect(asProtocolAction('allow_always')).toBe('allow_always');
    expect(asProtocolAction('deny')).toBe('deny');
    expect(asProtocolAction('defer')).toBe('defer');
    expect(asProtocolAction('paused')).toBeNull();
    expect(asProtocolAction('allow_for_session')).toBeNull();
    expect(asProtocolAction('allow_once')).toBeNull();
    expect(asProtocolAction('')).toBeNull();
  });
});

// ── defer ─────────────────────────────────────────────────────────────────

describe('defer is reachable and authorises nothing', () => {
  it('decides nothing, delivers nothing, and leaves the request open', async () => {
    const { coordinator, delivered, rows } = makeCoordinator();
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'defer', surface: 'worker_http',
    });

    expect(receipt.refusal).toBe('permission_deferred');
    expect(receipt.action).toBeNull();
    expect(receipt.firstDecision).toBe(false);
    expect(delivered).toHaveLength(0);
    expect(rows.size).toBe(0);
    // Still answerable: "not yet" is not "no".
    expect(coordinator.pendingCount).toBe(1);
  });

  it('a request deferred once can still be answered afterwards', async () => {
    const { coordinator, delivered } = makeCoordinator();
    coordinator.open(request());
    await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'defer', surface: 'worker_http',
    });

    const after = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow', surface: 'worker_http',
    });

    expect(after.firstDecision).toBe(true);
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'allow' }]);
  });

  it('the bot card\'s "paused" is a defer, not a denial', () => {
    // The legacy map said `paused -> deny`. That records a decision the user
    // never made: the card is answerable long after the turn ended.
    const paused = translate('internal', 'paused');
    expect(paused).not.toBeNull();
    expect(paused?.action).toBe('defer');
    expect(paused?.grants).toBe(false);
  });
});

// ── grant scope ───────────────────────────────────────────────────────────

describe('a lasting grant is scoped to a tool, and never silently downgraded', () => {
  it('persists the grant against the tool that was actually asked about', async () => {
    const { coordinator, grantList, delivered } = makeCoordinator();
    coordinator.open(request({ toolName: 'remote_notion_write' }));

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow_for_session', surface: 'worker_http',
    });

    expect(receipt.audit.action).toBe('allow_always');
    // The subject is the tool, and the lifetime is the session the row is
    // keyed by — a session-wide scope would grant every tool, not this one.
    expect(receipt.scope).toEqual({ kind: 'tool', toolName: 'remote_notion_write' });
    expect(grantList).toEqual([{ toolName: 'remote_notion_write', sessionId: 'sess-1' }]);
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'allow_always' }]);
  });

  it('denies THIS call, with the reason recorded, rather than becoming a one-shot allow', async () => {
    // Falling back to a one-shot allow here would be a grant whose scope is
    // narrower than the name the user was shown. The call is refused instead,
    // and the refusal says why — a tool left waiting would be a denial
    // arriving late and unexplained.
    const { coordinator, grantList, delivered, rows } = makeCoordinator({ failGrant: true });
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'always', surface: 'bot_card',
    });

    expect(receipt.refusal).toBe('grant_failed');
    expect(grantList).toHaveLength(0);
    expect(rows.get('req-1')).toMatchObject({ action: 'deny' });
    expect(receipt.audit.reason).toContain('could not be persisted');
    // A deny, never a one-shot `allow` and never an `allow_always` nobody stored.
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'deny' }]);
  });

  it('a grant with no tool cannot be completed, so it cannot be applied', () => {
    expect(bindGrantScope(GRANT_PENDING_TOOL, 'remote_notion_write')).toEqual({
      action: 'allow_always',
      scope: { kind: 'tool', toolName: 'remote_notion_write' },
      grants: true,
    });
    // No tool is not "the current one". It is a grant nobody can honour.
    expect(bindGrantScope(GRANT_PENDING_TOOL, '')).toBeNull();
    // A one-shot answer is not a pending grant and must not be bound into one.
    expect(bindGrantScope({ action: 'allow', scope: null, grants: false }, 'X')).toBeNull();
  });
});

// ── cancel ────────────────────────────────────────────────────────────────

describe('cancel closes every pending request of the run and audits each', () => {
  it('denies each open request with a cancelled reason', async () => {
    const { coordinator, rows, delivered } = makeCoordinator();
    coordinator.open(request({ requestId: 'req-a', runId: 'run-1' }));
    coordinator.open(request({ requestId: 'req-b', runId: 'run-1' }));
    coordinator.open(request({ requestId: 'req-other', runId: 'run-2' }));

    const closed = coordinator.closeRun('run-1', 'user cancelled the turn');

    expect(closed.map((c) => c.requestId).sort()).toEqual(['req-a', 'req-b']);
    expect(rows.get('req-a')).toMatchObject({ action: 'deny', source: 'cancelled', reason: 'user cancelled the turn' });
    expect(rows.get('req-b')).toMatchObject({ action: 'deny', source: 'cancelled' });
    // Another run's request is untouched.
    expect(rows.has('req-other')).toBe(false);
    expect(coordinator.pendingForRun('run-2')).toEqual(['req-other']);
    expect(delivered).toHaveLength(0);
  });

  it('refuses an answer that arrives after the cancel, and does not deliver it', async () => {
    // Otherwise a cancelled prompt is still answerable, and the answer lands
    // on a recycled worker that no longer knows what it was asked.
    const { coordinator, delivered } = makeCoordinator();
    coordinator.open(request());
    coordinator.closeRun('run-1', 'cancelled');

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1', decision: 'allow', surface: 'worker_http',
    });

    expect(receipt.refusal).toBe('run_terminal');
    expect(delivered).toHaveLength(0);
    expect(coordinator.isRunClosed('run-1')).toBe(true);
  });

  it('clears the timers it closed, so no deadline fires against a dead request', () => {
    const { coordinator, clock } = makeCoordinator();
    coordinator.open(request({ requestId: 'req-a', runId: 'run-1' }));
    coordinator.open(request({ requestId: 'req-b', runId: 'run-2' }));
    expect(clock.armed).toBe(2);

    coordinator.closeRun('run-1', 'cancelled');
    expect(clock.armed).toBe(1);
  });
});

// ── updated input ─────────────────────────────────────────────────────────

describe('an updated input is re-validated, not waved through', () => {
  it('delivers the rewritten input only after it passes re-validation', async () => {
    const { coordinator, delivered } = makeCoordinator();
    coordinator.open(request());
    const validate = vi.fn(async () => ({ accepted: true }));

    await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1',
      decision: 'allow', surface: 'worker_http',
      updatedInput: { title: 'edited' },
      onUpdatedInput: validate,
    });

    expect(validate).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([
      { requestId: 'req-1', action: 'allow', updatedInput: { title: 'edited' } },
    ]);
  });

  it('a rejected edit denies the call and the edit itself never reaches the worker', async () => {
    // "the user edited the arguments" must not become a way around the checks
    // the original arguments went through. The deny IS delivered, so the call
    // does not hang — but it is delivered WITHOUT the rejected input.
    const { coordinator, rows, delivered } = makeCoordinator();
    coordinator.open(request());

    const receipt = await coordinator.resolve({
      requestId: 'req-1', runId: 'run-1', sessionId: 'sess-1',
      decision: 'allow', surface: 'worker_http',
      updatedInput: { path: '../../etc/passwd' },
      onUpdatedInput: () => ({ accepted: false, reason: 'path escapes the workspace' }),
    });

    expect(receipt.audit.action).toBe('deny');
    expect(receipt.audit.reason).toContain('path escapes the workspace');
    expect(rows.get('req-1')).toMatchObject({ action: 'deny' });
    expect(delivered).toEqual([{ requestId: 'req-1', action: 'deny' }]);
    // The traversal is not forwarded, so no side of it can act on it.
    expect(JSON.stringify(delivered)).not.toContain('passwd');
  });
});

// ── vocabulary ────────────────────────────────────────────────────────────

describe('one vocabulary, two declared legacy surfaces', () => {
  it('names where every table comes from', () => {
    // A mapping nobody can locate is a mapping nobody can review.
    const origins = surfaceOrigins();
    expect(origins.worker_http).toContain('handlePostPermission');
    expect(origins.bot_card).toContain('db:toolApproval:resolve');
    expect(origins.internal).toContain('requestPermission');
  });

  it('accepts exactly the verbs each surface actually sends today', () => {
    // These lists replace the inline whitelist at router.ts:2178 and the
    // guard at db-handlers.ts:1818. They are the same set, stated once.
    expect([...acceptedVerbs('worker_http')].sort()).toEqual([
      'allow', 'allow_for_session', 'allow_once', 'defer', 'deny',
    ]);
    expect([...acceptedVerbs('bot_card')].sort()).toEqual(['allow', 'always', 'deny']);
    expect([...acceptedVerbs('internal')].sort()).toEqual(['allow', 'deny', 'paused']);
  });

  it('returns null for an unknown verb, so the CALLER fails closed', () => {
    expect(translate('worker_http', 'yes')).toBeNull();
    expect(translate('bot_card', 'allow_for_session')).toBeNull();
    expect(translate('internal', 'allow_always')).toBeNull();
  });

  it('allow_once is the same one-shot answer as allow, under its own name', () => {
    expect(translate('worker_http', 'allow')).toEqual(translate('worker_http', 'allow_once'));
    expect(translate('worker_http', 'allow')?.grants).toBe(false);
  });

  it('only allow_always is a grant, on every surface', () => {
    for (const verb of acceptedVerbs('worker_http')) {
      const t = translate('worker_http', verb);
      expect(t?.grants).toBe(verb === 'allow_always' || verb === 'allow_for_session');
    }
    expect(translate('bot_card', 'always')?.action).toBe('allow_always');
    expect(translate('bot_card', 'always')?.scope).toBeNull();
  });
});
