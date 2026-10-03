/**
 * sessionGrantScope.test.ts — plan 587 R2.4, worker-side wiring.
 *
 * ## What is proven, and what is not
 *
 * PROVEN (behaviourally, in `apps/desktop/src/main/db/toolApprovalState-grant-scope.test.ts`):
 * the durable store is session-keyed and survives a process boundary.
 *
 * PROVEN HERE: that the worker's `allow_for_session` branch actually writes to
 * that store, seeds its in-process cache from it, and scopes it per session.
 *
 * NOT PROVEN, and not claimed: that a real worker process really performs this
 * round trip. The `permission:resolve` handler is a case arm inside a module
 * that is only meaningful as a running child process, so driving it end to end
 * needs a real worker, a real renderer and a real click. That is the host-boundary
 * half of R2.4 and it stays open.
 *
 * ## Why source assertions at all
 *
 * Because they are the half that actually changed, and they fail on master: the
 * `allow_for_session` branch existed and called `rememberSessionApproval` --
 * process memory, keyed by bare tool name -- with no durable write anywhere. A
 * reader can check that claim at `process/agent-process-entry.ts` in one glance,
 * which is the same reasoning R2.1 used for its `NON_DESKTOP_CONSUMERS` check.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = join(HERE, '..', '..', 'src', 'process', 'agent-process-entry.ts');
const DB_CLIENT = join(HERE, '..', '..', 'src', 'ipc', 'db-client.ts');

/** The `allow_for_session` branch, so an assertion cannot match unrelated text. */
function allowForSessionBranch(entry: string): string {
  const at = entry.indexOf("decision === 'allow_for_session'");
  expect(at, 'the allow_for_session branch must exist').toBeGreaterThan(-1);
  return entry.slice(at, at + 4000);
}

describe('the worker path writes a durable session grant', () => {
  let entry: string;

  beforeAll(() => {
    entry = readFileSync(WORKER_ENTRY, 'utf8');
  });

  it('persists the grant rather than only remembering it in process memory', () => {
    // The assertion that fails on master.
    expect(allowForSessionBranch(entry)).toContain('toolApprovalDb.upsertRule({');
  });

  it('keys the row by the session scope recorded for that session', () => {
    // Not by tool name and not by process: the scope id is the session (or the
    // bot, on the bot surface), which is what makes the grant survive a recycle
    // and stay out of a neighbouring session.
    const branch = allowForSessionBranch(entry);
    expect(branch).toContain('permissionScopes.get(resolveSessionId)');
    expect(branch).toContain('scopeId: scope.scopeId');
  });

  it('reports a grant write that failed instead of reporting it remembered', () => {
    // "The user clicked always allow" and "the grant is stored" are two facts.
    // Only the first is true when the write fails, and the difference is the
    // next prompt for the same tool.
    const branch = allowForSessionBranch(entry);
    expect(branch).toContain('session grant write failed');
    expect(branch).toContain('could not be persisted');
  });

  it('falls back to the session scope when no scope was recorded', () => {
    // The narrower of the two scopes: a mis-scoped bot grant leaks across
    // conversations, a mis-scoped session grant only asks again.
    expect(allowForSessionBranch(entry)).toContain('scopeType: \'session\' as const');
  });
});

describe('the in-process cache mirrors the durable grant, and is scoped per session', () => {
  let entry: string;

  beforeAll(() => {
    entry = readFileSync(WORKER_ENTRY, 'utf8');
  });

  it('seeds the cache from the durable read at chat:start', () => {
    // Otherwise a grant recorded by the bot approval card is honoured by the
    // table and invisible to the connector branch that consults the cache, and
    // the two quietly disagree about what the user allowed.
    expect(entry).toContain('for (const tool of approvedAlwaysAllowTools) rememberSessionApproval(tool)');
  });

  it('records the grant scope per session', () => {
    // `chat:start` is the only place that knows whether this is a bot surface
    // or an interactive one, and the surface decides the scope.
    expect(entry).toContain('permissionScopes.set(msg.sessionId, grantScope)');
  });

  it('drops the grant scope when the session ends', () => {
    // A scope that outlived its session would send the NEXT session's "always
    // allow" into the previous session's row -- a grant that follows the
    // process instead of the conversation, which is the failure §E forbids.
    expect(entry).toContain('permissionScopes.delete(msg.sessionId)');
  });
});

describe('the worker can write the rules table it already read', () => {
  it('offers a write beside the read that has existed since plan 498', () => {
    // A write with no read, or a read with no write, is the same defect in
    // opposite directions, so both are asserted in the same place.
    const client = readFileSync(DB_CLIENT, 'utf8');
    expect(client).toContain('upsertRule:');
    expect(client).toContain('listRules:');
  });

  it('the process cache is documented as a cache, not as the grant', () => {
    // The old file claimed "process lifetime === session lifetime" and was
    // right only by accident. The claim now has to be the weaker, true one,
    // and it has to name the store that actually backs the grant.
    const approvals = readFileSync(
      join(HERE, '..', '..', 'src', 'tool', 'AppConnectionTool', 'approvals.ts'),
      'utf8',
    );
    expect(approvals).toContain('NOT the session grant');
    expect(approvals).toContain('tool_approval_rules');
    // The coincidence the old header relied on must be named as a coincidence.
    expect(approvals).toContain('COINCIDENCE');
  });
});
