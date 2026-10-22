/**
 * `/healthz` must not advertise run execution it cannot serve.
 *
 * ## What is under test
 *
 * `agent_run_execution` is the capability a client attaches on: if the Host
 * says it provides the name, the client sends its turns here instead of
 * starting a competing Host. So the failure that matters is the reverse of a
 * missing feature — a LEDGER-ONLY Host (one assembled without a
 * `runExecutionApi`) that advertises execution anyway. The client would attach,
 * then fail on the first turn against a route that answers
 * `agent_run_execution_unavailable`.
 *
 * The capability is DERIVED from the registered API, never declared by the
 * caller, which is why the two cases below differ only in whether that option
 * is passed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { HostRunExecutionApiV1 } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';

let server: HostSessionHttpServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** An execution API that is never called by `/healthz`; the routes are not under test. */
function executionApi(): HostRunExecutionApiV1 {
  return {
    async startAgentRun() {
      throw new Error('healthz must not start a run');
    },
    async cancelAgentRun() {
      throw new Error('healthz must not cancel a run');
    },
  };
}

async function handshake(options: Partial<HostSessionHttpServerOptions>) {
  server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: 'test-token',
    ...options,
  });
  await server.listen();
  const client = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, 'test-token');
  return client.handshake();
}

describe('Host health run execution capability', () => {
  it('advertises agent_run_execution when an execution API is registered', async () => {
    const health = await handshake({ runExecutionApi: executionApi() });
    expect(health.provides).toContain('agent_run_execution');
    expect(health.unsupported?.agent_run_execution).toBeUndefined();
  });

  it('withholds agent_run_execution from a ledger-only Host and states why', async () => {
    const health = await handshake({});
    expect(health.provides).not.toContain('agent_run_execution');
    // A refusal a client cannot put into words reads as a bug, so absence has
    // to carry the same derived reason every other missing name carries.
    expect(health.unsupported?.agent_run_execution).toBeTruthy();
  });
});
