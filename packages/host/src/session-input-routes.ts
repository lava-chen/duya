/**
 * The HTTP surface for Session inputs and the per-session control lease.
 *
 * ## Why the identity is not on the wire
 *
 * Nothing in this file reads an actor out of a request body. The Host binds
 * the identity when it assembles the service — from the authenticated caller
 * — and the receipt ECHOES the actor it recorded. A request that could name
 * its own actor would let any caller post as a user, and the lease is
 * precisely the thing that decides who may direct a session.
 *
 * ## Why the routes are narrow
 *
 * Four verbs over two resources, and nothing else. The receipt is read by
 * `(sessionId, requestId)` because that is the key the caller already holds;
 * the lease is taken and given back by its own revision, because a holder
 * that lost the lease must not be able to release the new holder's.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HostSessionInputApiV1,
  SessionControlLeaseRequest,
  SessionInputRequest,
} from '@duya/agent-protocol';
import { HostSessionInputApiError } from './session-input-api.js';

const ROOT = '/v1/session-inputs';
const RECEIPT = `${ROOT}/receipt`;
const LEASE = `${ROOT}/lease`;
const LEASE_RELEASE = `${ROOT}/lease/release`;
/** The lifetime a lease gets when the caller does not ask for one. */
const DEFAULT_LEASE_TTL_MS = 60_000;

interface RoutePorts {
  readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null>;
  sendJson(response: ServerResponse, status: number, body: unknown): void;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !value.includes('\0');
}

function intent(value: unknown): value is SessionInputRequest['intent'] {
  return value === 'steer' || value === 'enqueue' || value === 'interrupt';
}

function only(body: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(body).every((key) => fields.includes(key));
}

/**
 * Registered after the Host's bearer-token and no-Origin checks, so only
 * privileged local callers reach it.
 */
export async function routeSessionInputs(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  api: HostSessionInputApiV1 | undefined,
  ports: RoutePorts,
): Promise<void> {
  const send = (status: number, body: unknown): void => ports.sendJson(response, status, body);
  if (!api) {
    send(503, { error: { code: 'session_input_api_unavailable' } });
    return;
  }
  try {
    if (url.pathname === ROOT && request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['sessionId', 'requestId', 'intent', 'content']) ||
          !id(body.sessionId) || !id(body.requestId) || !intent(body.intent) ||
          typeof body.content !== 'string') {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      const receipt = await api.submitInput({
        sessionId: body.sessionId,
        requestId: body.requestId,
        intent: body.intent,
        content: body.content,
      });
      send(200, { receipt });
      return;
    }
    if (url.pathname === RECEIPT && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      const requestId = url.searchParams.get('requestId');
      if (!id(sessionId) || !id(requestId)) {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      const receipt = await api.readInputReceipt(sessionId, requestId);
      if (receipt === null) {
        send(404, { error: { code: 'session_input_not_found' } });
        return;
      }
      send(200, { receipt });
      return;
    }
    if (url.pathname === LEASE && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!id(sessionId)) {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      send(200, { lease: await api.readControlLease(sessionId) });
      return;
    }
    if (url.pathname === LEASE && request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['sessionId', 'requestId', 'expectedRevision', 'ttlMs']) ||
          !id(body.sessionId) || !id(body.requestId)) {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      const expectedRevision = body.expectedRevision;
      if (expectedRevision !== undefined &&
          (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      const ttlMs = body.ttlMs;
      if (ttlMs !== undefined &&
          (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 1)) {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      const leaseRequest: SessionControlLeaseRequest = {
        sessionId: body.sessionId,
        requestId: body.requestId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ttlMs: ttlMs ?? DEFAULT_LEASE_TTL_MS,
      };
      const lease = await api.acquireControlLease(leaseRequest);
      // A refused grant is an ordinary outcome, not an error: the caller asked
      // for the session and somebody else holds it. The body says which.
      send(200, { lease });
      return;
    }
    if (url.pathname === LEASE_RELEASE && request.method === 'POST') {
      const body = await ports.readJson(request, response);
      if (body === null) return;
      if (!only(body, ['sessionId', 'revision']) || !id(body.sessionId) ||
          typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1) {
        send(400, { error: { code: 'invalid_session_input_request' } });
        return;
      }
      send(200, { released: await api.releaseControlLease(body.sessionId, body.revision) });
      return;
    }
    send(404, { error: { code: 'not_found' } });
  } catch (error) {
    if (error instanceof HostSessionInputApiError) {
      send(400, { error: { code: error.code } });
      return;
    }
    send(500, { error: { code: 'session_input_failed' } });
  }
}
