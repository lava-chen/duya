/**
 * `POST /v1/workspace/file` — reading one file out of a registered workspace.
 *
 * ## What is under test, and what is deliberately not
 *
 * The interesting property of this route is not that it returns a file. It is
 * that the CLIENT CANNOT NAME A PATH OUTSIDE THE WORKSPACE: the request carries
 * a Workspace ID and a relative path, so "read C:\Users\...\secrets" has no
 * spelling in this API. That is why these cases assert on refusals as much as on
 * success, and why the fixture below wires a real directory tree rather than a
 * stub that returns a canned string.
 *
 * The containment check itself lives in the existing workspace resolver, which
 * has its own tests. What is new here and therefore what is tested here:
 *
 *  - the route is reachable at all, and is absent (404) on a Host that did not
 *    register the API, so `workspace_filesystem` never advertises a route that
 *    does not exist;
 *  - the capability is DERIVED from the registered API rather than declared;
 *  - a symlink that leaves the workspace is refused even though the path used
 *    to reach it is legal — path-level containment cannot see that one;
 *  - the byte cap belongs to the Host: a client may ask for less, never more.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceId } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { createHostLocalWorkspaceFileApi } from '../src/local-workspace-file-api.js';
import type { HostWorkspaceAccess } from '../src/session-api.js';

const WORKSPACE_ID = 'ws-file-read' as WorkspaceId;
const ROOT_ID = 'root-file-read';

/** A workspace access that resolves to a REAL directory, so containment is real. */
function workspaceAccessFor(root: string): HostWorkspaceAccess {
  return {
    resolvePath(workspaceId, _rootId, relativePath = '') {
      if (workspaceId !== WORKSPACE_ID) return null;
      // The same judgement the production resolver makes: a relative path that
      // escapes is rejected rather than normalised, because normalisation is
      // where containment bugs come from.
      const normalized = relativePath.replace(/\\/g, '/');
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
      const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
      if (segments.some((segment) => segment === '..')) return null;
      return path.resolve(root, ...segments);
    },
  };
}

describe('Host workspace file read', () => {
  let root: string;
  let outside: string;
  let server: HostSessionHttpServer;
  let client: HostSessionHttpClient;
  let maxBytes: number | undefined;

  async function boot(options: { registerApi: boolean }): Promise<void> {
    maxBytes = 64;
    server = new HostSessionHttpServer({
      api: {} as HostSessionHttpServerOptions['api'],
      taskApi: {} as HostSessionHttpServerOptions['taskApi'],
      token: 'test-token',
      ...(options.registerApi
        ? { workspaceFileApi: createHostLocalWorkspaceFileApi({ workspaces: workspaceAccessFor(root), maxBytes }) }
        : {}),
    });
    await server.listen();
    client = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, 'test-token');
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-ws-read-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-ws-outside-'));
    await fs.writeFile(path.join(root, 'notes.md'), '# notes\nthe workspace root is readable\n');
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'deep.txt'), 'nested file\n');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours\n');
  });

  afterEach(async () => {
    await server?.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('reads a file in the workspace and a file nested inside it', async () => {
    await boot({ registerApi: true });

    const top = await client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'notes.md' });
    expect(top.content).toContain('the workspace root is readable');
    expect(top.totalBytes).toBe(top.content.length);
    expect(top.truncated).toBe(false);
    // The response must not leak the Host's own absolute layout.
    expect(top.relativePath).toBe('notes.md');
    expect(top.content).not.toContain(root);

    const nested = await client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'docs/deep.txt' });
    expect(nested.content).toBe('nested file\n');
  });

  it('advertises workspace_filesystem only when the route is actually registered', async () => {
    // The control. A capability advertised by a Host that has no route behind it
    // is an affordance that throws when a user clicks it.
    await boot({ registerApi: false });
    expect((await client.handshake()).provides).not.toContain('workspace_filesystem');
    await expect(client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'notes.md' })).rejects.toThrow();

    await server.close();
    await boot({ registerApi: true });
    expect((await client.handshake()).provides).toContain('workspace_filesystem');
  });

  it('refuses a path that escapes the workspace, and says so without guessing which', async () => {
    await boot({ registerApi: true });

    // `..` never reaches the filesystem: the resolver rejects it, so the two
    // escapes below produce the SAME answer as a file that is simply not there.
    // That is the point — a distinguishable error here enumerates the tree.
    for (const attempt of ['../secret.txt', 'docs/../../secret.txt', path.join(outside, 'secret.txt')]) {
      await expect(client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: attempt }))
        .rejects.toMatchObject({ status: 404 });
    }
    await expect(client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'absent.md' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('refuses a symlink that leaves the workspace, even though its path is legal', async () => {
    await boot({ registerApi: true });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));

    // This is the case path-level containment cannot see: `escape.txt` sits
    // inside the root, and only following the link reveals that it is not.
    await expect(client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'escape.txt' }))
      .rejects.toMatchObject({ status: 403, code: 'workspace_file_outside_root' });
  });

  it('refuses a directory rather than reporting it as an empty file', async () => {
    await boot({ registerApi: true });
    await expect(client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'docs' }))
      .rejects.toMatchObject({ status: 400, code: 'workspace_file_is_directory' });
  });

  it('caps at the Host\'s limit: the client may ask for less, never for more', async () => {
    await boot({ registerApi: true });

    const smaller = await client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'notes.md', maxBytes: 8 });
    expect(smaller.content).toHaveLength(8);
    expect(smaller.truncated).toBe(true);
    // totalBytes is the file, not the slice — otherwise a caller cannot tell a
    // truncated read from a short file.
    expect(smaller.totalBytes).toBeGreaterThan(8);

    // Asking for more than the Host serves does not raise the Host's own limit.
    // The file still fits under it, so the read succeeds — and returns the file,
    // never more than the Host's cap.
    const greedy = await client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'notes.md', maxBytes: 10_000 });
    expect(greedy.content.length).toBeLessThanOrEqual(64);
    expect(greedy.content).toContain('the workspace root is readable');

    // A file the Host would not serve at all is refused outright, whatever the
    // client asked for. Capping silently would hand back a file that looks
    // short rather than refused.
    await fs.writeFile(path.join(root, 'big.bin'), 'x'.repeat(200));
    for (const maxBytes of [undefined, 10_000]) {
      await expect(
        maxBytes === undefined
          ? client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'big.bin' })
          : client.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'big.bin', maxBytes }),
      ).rejects.toMatchObject({ status: 413 });
    }
  });

  it('refuses an unknown workspace with the same 404 it uses for an unknown file', async () => {
    await boot({ registerApi: true });
    await expect(client.readWorkspaceFile({ workspaceId: 'ws-nope' as WorkspaceId, relativePath: 'notes.md' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('does not answer an unauthenticated caller', async () => {
    await boot({ registerApi: true });
    const stranger = new HostSessionHttpClient(`http://127.0.0.1:${server.port}`, 'wrong-token');
    await expect(stranger.readWorkspaceFile({ workspaceId: WORKSPACE_ID, relativePath: 'notes.md' })).rejects.toThrow();
  });
});
