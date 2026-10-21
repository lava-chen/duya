/**
 * A stub of the same-origin BFF, enough to drive the workspace store.
 *
 * It exists so the store's own contract can be tested — selection scoping,
 * refusal handling, the cancellation ledger — without a Host, a worker or a
 * provider. The routes and response shapes mirror `src/server/web-bff.ts`
 * exactly, because a stub that is more forgiving than the server would let the
 * store ship a shape the server never sends.
 */

import type { FetchLike } from '../../src/client/api.js';

export interface StubSession {
  readonly id: string;
  readonly title: string;
  readonly workingDirectory?: string;
  readonly model?: string;
  readonly recencyAt?: number;
}

export interface StubMessage {
  readonly id: string;
  readonly turnId: string | null;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: number;
}

export interface StubRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';
  readonly createdAt: number;
}

export interface StubApproval {
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly status: 'pending' | 'allow' | 'deny' | 'timeout' | 'aborted';
  readonly decision?: string | null;
  readonly createdAt: number;
  readonly resolvedAt?: number | null;
}

export interface StubBffOptions {
  readonly sessions?: readonly StubSession[];
  readonly messages?: Readonly<Record<string, readonly StubMessage[]>>;
  readonly runs?: Readonly<Record<string, readonly StubRun[]>>;
  readonly approvals?: Readonly<Record<string, readonly StubApproval[]>>;
  /** Replace a route with a custom answer; receives the request path. */
  readonly overrides?: Readonly<Record<string, (url: URL, init?: RequestInit) => Promise<Response>>>;
}

export interface StubBff {
  readonly fetchImpl: FetchLike;
  readonly calls: { method: string; path: string; csrf: string | null }[];
  setRuns(sessionId: string, runs: readonly StubRun[]): void;
  setApprovals(sessionId: string, approvals: readonly StubApproval[]): void;
  setCancelOutcome(outcome: { requested: boolean; reason?: string }): void;
  setStartOutcome(outcome: { accepted: boolean; runId?: string; reason?: string }): void;
}

const CSRF = 'stub-csrf-token';

export function createStubBff(options: StubBffOptions = {}): StubBff {
  const calls: StubBff['calls'] = [];
  let sessions = options.sessions ?? [];
  let messages: Record<string, readonly StubMessage[]> = { ...options.messages };
  let runs: Record<string, readonly StubRun[]> = { ...options.runs };
  let approvals: Record<string, readonly StubApproval[]> = { ...options.approvals };
  let cancelOutcome: { requested: boolean; reason?: string } = { requested: true };
  let startOutcome: { accepted: boolean; runId?: string; reason?: string } = { accepted: true, runId: 'run-stub-1' };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input, 'http://stub.local');
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    calls.push({
      method,
      path,
      csrf: headerOf(init, 'x-duya-csrf'),
    });

    const override = options.overrides?.[path];
    if (override !== undefined) return await override(url, init);

    if (method === 'GET' && path === '/api/bootstrap') return json({ apiVersion: 1, csrfToken: CSRF });
    if (method === 'GET' && path === '/api/handshake') {
      return json({ ok: true, apiVersion: 1, protocol: { major: 1, minor: 0 }, databaseReady: true });
    }
    if (method === 'GET' && path === '/api/sessions') {
      return json({
        sessions: sessions.map((session) => ({
          session: sessionRecord(session),
          timelineCount: (messages[session.id] ?? []).length,
        })),
        nextCursor: null,
      });
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (method === 'GET' && messagesMatch !== null) {
      const sessionId = decodeURIComponent(messagesMatch[1] ?? '');
      return json({
        sessionId,
        messages: (messages[sessionId] ?? []).map(messageItem),
        nextCursor: null,
      });
    }

    const runsMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(path);
    if (method === 'GET' && runsMatch !== null) {
      const sessionId = decodeURIComponent(runsMatch[1] ?? '');
      return json({ runs: runs[sessionId] ?? [] });
    }

    const approvalsMatch = /^\/api\/sessions\/([^/]+)\/approvals$/.exec(path);
    if (method === 'GET' && approvalsMatch !== null) {
      const sessionId = decodeURIComponent(approvalsMatch[1] ?? '');
      // The route is the PENDING ledger: a resolved request must disappear from
      // it, exactly as it does on the real Host.
      return json({ approvals: (approvals[sessionId] ?? []).filter((entry) => entry.status === 'pending') });
    }

    if (method === 'POST' && path === '/api/runs/start') {
      if (!startOutcome.accepted) {
        return json({ accepted: false, stage: 'refused_dispatch_failed', reason: startOutcome.reason ?? 'stub' }, 202);
      }
      return json({ accepted: true, stage: 'dispatched', runId: startOutcome.runId ?? 'run-stub-1' }, 202);
    }

    const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
    if (method === 'POST' && cancelMatch !== null) {
      const runId = decodeURIComponent(cancelMatch[1] ?? '');
      if (cancelOutcome.requested) return json({ requested: true, runId });
      return json({ requested: false, runId, reason: cancelOutcome.reason ?? 'run_not_active' });
    }

    const resolveMatch = /^\/api\/approvals\/([^/]+)\/resolve$/.exec(path);
    if (method === 'POST' && resolveMatch !== null) {
      const id = decodeURIComponent(resolveMatch[1] ?? '');
      const decision = readDecision(init);
      const requestId = id;
      for (const [sessionId, list] of Object.entries(approvals)) {
        const index = list.findIndex((entry) => entry.id === requestId);
        if (index === -1) continue;
        const next = [...list];
        next[index] = {
          ...list[index]!,
          status: decision === 'deny' ? 'deny' : 'allow',
          decision,
          resolvedAt: 1_700_000_100_000,
        };
        approvals = { ...approvals, [sessionId]: next };
        return json({ result: next[index] });
      }
      return json({ error: { code: 'approval_not_found' } }, 404);
    }

    const streamMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
    if (method === 'GET' && streamMatch !== null) {
      // A stream that never yields and never ends: the store is not what decides
      // how a run progresses, and a test that needed events would be testing the
      // surface model instead.
      return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    return json({ error: { code: 'not_found' } }, 404);
  };

  return {
    fetchImpl,
    calls,
    setRuns(sessionId, next): void {
      runs = { ...runs, [sessionId]: next };
    },
    setApprovals(sessionId, next): void {
      approvals = { ...approvals, [sessionId]: next };
    },
    setCancelOutcome(next): void {
      cancelOutcome = next;
    },
    setStartOutcome(next): void {
      startOutcome = next;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionRecord(session: StubSession): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    projectName: '',
    status: 'active',
    model: session.model ?? 'test-model',
    providerId: 'test-provider',
    mode: 'code',
    permissionMode: 'default',
    agentProfileId: null,
    parentSessionId: null,
    agentType: 'main',
    agentName: 'Duya',
    draft: null,
    extensions: {},
    createdAt: session.recencyAt ?? 1_700_000_000_000,
    updatedAt: session.recencyAt ?? 1_700_000_000_000,
    recencyAt: session.recencyAt ?? 1_700_000_000_000,
    lastTurnStartedAt: null,
    workspace: session.workingDirectory === undefined
      ? { state: 'legacy_unbound' }
      : { state: 'bound', workspaceId: 'ws-1', rootId: null, relativePath: session.workingDirectory },
  };
}

function messageItem(message: StubMessage): Record<string, unknown> {
  return {
    id: message.id,
    sequence: 1,
    createdAt: message.createdAt,
    turnId: message.turnId,
    entry: {
      type: 'message',
      id: message.id,
      parentId: null,
      createdAt: message.createdAt,
      message: { role: message.role, content: message.text },
    },
  };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  const found = Object.entries(record).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? null;
}

function readDecision(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') return 'allow';
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (typeof parsed === 'object' && parsed !== null) {
      const decision = (parsed as Record<string, unknown>)['decision'];
      if (typeof decision === 'string') return decision;
    }
  } catch {
    return 'allow';
  }
  return 'allow';
}
