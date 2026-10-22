/**
 * T15 — the degradation loop for one real interface capability.
 *
 * ## What this pins down
 *
 * The client says what it can CONSUME, the Host answers with what it can
 * PROVIDE plus version, limits and a reason for anything it does not, and the
 * client refuses a request it was told is unsupported BEFORE issuing it. The
 * capability closed end to end here is reading a file out of the agent
 * workspace, which on the provide axis is named `workspace_filesystem`.
 *
 * `workspace.read` is NOT that name. It is the Desktop plugin permission
 * vocabulary (`apps/desktop/src/renderer/components/settings/capabilities/`
 * and `packages/plugin-core`), a different axis with a different owner. Using
 * it here would put a plugin permission into a protocol handshake, which is the
 * direction mix-up `agent-protocol/src/version.ts:116` exists to prevent.
 *
 * ## Why the Host is the real one
 *
 * Every case below boots the real `HostSessionHttpServer` and talks to it
 * through the real `HostSessionHttpClient`. A hand-rolled fake would prove only
 * that the fake agrees with itself; the refusal has to survive the wire.
 *
 * ## Why the counts are asserted
 *
 * A negotiation where both sides are empty passes every "ok" check while having
 * checked nothing. Each test therefore pins the number of capabilities
 * declared, provided, accepted and refused, so a future change that silently
 * empties either side cannot read as a pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_OWNERS,
  PROTOCOL_CAPABILITIES,
  type HostCapability,
  type WorkspaceId,
} from '@duya/agent-protocol';
import type { HostHandshakeV1 } from '@duya/host/http-client';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '@duya/host/http-server';
import {
  CLI_HOST_DECLARATION,
  WORKSPACE_READ_CAPABILITY,
  negotiateHostCapabilities,
  requestWorkspaceFileRead,
} from '../src/host-capability-gate.js';

const TOKEN = 'test-token';
const WORKSPACE_ID = 'ws-degradation' as WorkspaceId;

interface WorkspaceFileStub {
  readonly calls: { workspaceId: string; relativePath: string }[];
}

/**
 * A Host that serves the workspace file read and records every attempt, so the
 * refusal can be proven by an empty call log rather than by an assertion about
 * the absence of an exception.
 */
function workspaceFileStub(): WorkspaceFileStub & NonNullable<HostSessionHttpServerOptions['workspaceFileApi']> {
  const calls: { workspaceId: string; relativePath: string }[] = [];
  const stub = {
    calls,
    async readWorkspaceFile(input: { readonly workspaceId: string; readonly relativePath: string }) {
      calls.push({ workspaceId: input.workspaceId, relativePath: input.relativePath });
      return {
        workspaceId: input.workspaceId as never,
        relativePath: input.relativePath,
        totalBytes: 12,
        content: 'notes content',
        truncated: false,
      };
    },
  };
  return stub as unknown as WorkspaceFileStub & NonNullable<HostSessionHttpServerOptions['workspaceFileApi']>;
}

describe('CLI capability degradation over the Host handshake', () => {
  let server: HostSessionHttpServer;
  let client: HostSessionHttpClient;
  let workspaceFiles: ReturnType<typeof workspaceFileStub>;

  async function bootHost(options?: {
    readonly withWorkspaceRead: boolean;
    readonly identity?: HostSessionHttpServerOptions['identity'];
  }): Promise<void> {
    workspaceFiles = workspaceFileStub();
    server = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: TOKEN,
      ...(options?.identity === undefined ? {} : { identity: options.identity }),
      ...(options?.withWorkspaceRead === true ? { workspaceFileApi: workspaceFiles } : {}),
    });
    await server.listen();
    client = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, TOKEN);
  }

  afterEach(async () => {
    await server?.close();
  });

  it('refuses to read a workspace file, and says why, when the Host does not provide it', async () => {
    await bootHost({ withWorkspaceRead: false });

    const handshake = await client.handshake(CLI_HOST_DECLARATION);
    const outcome = await requestWorkspaceFileRead(client, handshake, WORKSPACE_ID, 'notes.md');

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain(WORKSPACE_READ_CAPABILITY);
    expect(outcome.status === 'refused' && outcome.reason).toContain('duya-host');
    expect(outcome.status === 'refused' && outcome.reason)
      .toBe('duya-host 0.1.0 does not provide workspace_filesystem: Host duya-host registers no channel that serves workspace_filesystem');
    expect(workspaceFiles.calls).toEqual([]);

    // The Host still answers, and still answers partially: dropping the
    // workspace API removes one name, not the whole declaration.
    expect(handshake.provides).toEqual(['session_persistence']);
  });

  it('issues the read when the Host provides the capability', async () => {
    await bootHost({ withWorkspaceRead: true });

    const handshake = await client.handshake(CLI_HOST_DECLARATION);
    const outcome = await requestWorkspaceFileRead(client, handshake, WORKSPACE_ID, 'notes.md');

    expect(outcome.status).toBe('read');
    // The read carries Workspace IDENTITY and a relative path. There is no
    // absolute host path anywhere in the request, which is what makes the
    // capability a workspace capability rather than a filesystem one.
    expect(workspaceFiles.calls).toEqual([{ workspaceId: WORKSPACE_ID, relativePath: 'notes.md' }]);
    expect(outcome.status === 'read' && outcome.result.content).toBe('notes content');
  });

  it('refuses rather than assuming support when the Host declares no capabilities at all', async () => {
    await bootHost({ withWorkspaceRead: true });
    // A Host that answers the legacy health payload: still ok, still ready,
    // but silent about what it provides.
    const handshake = await client.handshake(CLI_HOST_DECLARATION);
    const silent: HostHandshakeV1 = { ...handshake, provides: undefined, unsupported: undefined };

    const negotiation = negotiateHostCapabilities(CLI_HOST_DECLARATION, silent, [WORKSPACE_READ_CAPABILITY]);
    const outcome = await requestWorkspaceFileRead(client, silent, WORKSPACE_ID, 'notes.md');

    expect(negotiation.provided).toBeNull();
    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain('did not declare');
    expect(workspaceFiles.calls).toEqual([]);
  });

  it('treats an advertised capability as a hint, not a credential', async () => {
    await bootHost({ withWorkspaceRead: true });
    const handshake = await client.handshake(CLI_HOST_DECLARATION);
    expect(handshake.provides).toContain(WORKSPACE_READ_CAPABILITY);

    // The gate passes on the same handshake, but the token does not, so the
    // Host still refuses. Advertising a capability grants nothing.
    const unauthenticated = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, 'wrong-token');
    await expect(unauthenticated.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'notes.md' }))
      .rejects.toMatchObject({ status: 403, code: 'invalid_bearer_token' });
    expect(workspaceFiles.calls).toEqual([]);
  });

  it('reports a non-empty negotiation on both sides so an empty one cannot read as a pass', async () => {
    await bootHost({ withWorkspaceRead: true });

    const handshake = await client.handshake(CLI_HOST_DECLARATION);
    const granted = negotiateHostCapabilities(CLI_HOST_DECLARATION, handshake, [WORKSPACE_READ_CAPABILITY]);

    expect(CLI_HOST_DECLARATION.capabilities.length).toBeGreaterThan(0);
    expect(granted.consumed).toEqual(CLI_HOST_DECLARATION.capabilities);
    expect(granted.provided?.length ?? 0).toBeGreaterThan(0);
    expect(granted.accepted).toEqual([WORKSPACE_READ_CAPABILITY]);
    expect(granted.refused).toEqual([]);
    expect(granted.provided?.every((c) => HOST_CAPABILITIES.includes(c))).toBe(true);
    // The gated capability follows the workspace, not the user, which is why a
    // client on another machine can still use it through this Host.
    expect(HOST_CAPABILITY_OWNERS[WORKSPACE_READ_CAPABILITY]).toBe('runtime');

    // Every capability the Host did not provide must carry a stated reason, so
    // a refusal can always be printed in words rather than as a blank.
    for (const capability of HOST_CAPABILITIES) {
      if (granted.provided?.includes(capability)) continue;
      expect(handshake.unsupported?.[capability]).toBeTruthy();
    }

    // Pinned counts, not just "greater than zero". Measured on this tree:
    // 23 provide-side names exist, this Host registers 2 of them, and the other
    // 21 each carry a reason. A future edit that silently empties either side
    // lands here instead of quietly passing every ok-shaped assertion.
    expect(HOST_CAPABILITIES.length).toBe(23);
    expect(granted.provided).toEqual(['session_persistence', 'workspace_filesystem']);
    expect(Object.keys(handshake.unsupported ?? {}).length).toBe(21);
    expect(handshake.consumedBy).toEqual([...CLI_HOST_DECLARATION.capabilities]);
    expect(handshake.limits?.absentCapabilityPolicy).toBe('error');
  });

  it('keeps every consume-side name the CLI declares inside the protocol vocabulary', async () => {
    expect(CLI_HOST_DECLARATION.capabilities.length).toBeGreaterThan(0);
    for (const name of CLI_HOST_DECLARATION.capabilities) {
      expect(PROTOCOL_CAPABILITIES).toContain(name);
    }
    // The provide axis and the consume axis must not share a name, or the
    // handshake would say "I provide X" about a capability the runtime only
    // promises to send.
    const overlap = CLI_HOST_DECLARATION.capabilities.filter(
      (name) => (HOST_CAPABILITIES as readonly string[]).includes(name),
    );
    expect(overlap).toEqual([]);
  });

  it('has no aliased capability pair on the provide axis, which is what makes a name gate complete here', () => {
    // The three renamed pairs named in 20-capability-directions.md §4 are all
    // EXECUTE against CONSUME. None of their names is a provide-side name, so a
    // by-name gate on `provides` cannot be fooled by an alias today. The day
    // one lands on this axis, this assertion goes red and the gate has to move
    // to the underlying predicate.
    const executeNames = ['checkpoint_repository', 'permission_coordinator', 'tool_preview'] as const;
    for (const name of executeNames) {
      expect((HOST_CAPABILITIES as readonly string[]).includes(name)).toBe(false);
    }
    for (const name of PROTOCOL_CAPABILITIES) {
      expect((HOST_CAPABILITIES as readonly string[]).includes(name)).toBe(false);
    }
    // And the gate under test really is name based, so pin that too.
    expect(WORKSPACE_READ_CAPABILITY).toBe('workspace_filesystem' satisfies HostCapability);
  });
});
