/**
 * Read one file out of a registered workspace.
 *
 * ## Why this is not the rollout import route
 *
 * `requestWorkspaceFileRead` rode `POST /v1/local/rollouts/import` because that
 * was the only route whose job was touching a workspace file. It is not a file
 * read: it parses a transcript, restores a session and returns an import
 * result, and it takes an ABSOLUTE path from the client. Wrapping it as a
 * "read a file" affordance would make the affordance's name a lie about what
 * runs.
 *
 * ## Containment is structural here
 *
 * The client sends a Workspace ID and a workspace-RELATIVE path. It never sends
 * a host path, so it cannot name a file outside the workspace: there is no
 * `..` to normalise away, no drive letter to reinterpret, and no absolute path
 * to smuggle. The existing resolver (`HostWorkspaceAccess.resolvePath`) owns
 * the mapping from identity to a canonical root and already rejects a relative
 * path that escapes, so this module does not re-implement that judgement.
 *
 * What this module DOES own, and pins with tests:
 *
 *  - a symlink inside the workspace that points outside it is refused, even
 *    though the path it is reached by is legal. Path-level containment cannot
 *    see that; the caller has to be a directory, and its real target has to be
 *    inside the resolved root.
 *  - a directory is refused rather than read as an empty file.
 *  - the byte cap is the Host's (`HOST_MAX_FILE_BYTES`), not the client's.
 *    `maxBytes` may ask for LESS; it may not ask for more.
 *  - `relativePath` comes back as asked, never as the Host's absolute path, so
 *    a caller cannot learn the workspace layout from a response.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspaceId } from '@duya/agent-protocol';
import type {
  HostWorkspaceFileReadInput,
  HostWorkspaceFileReadResult,
} from '@duya/agent-protocol/session-api';
import type { HostWorkspaceAccess } from './session-api.js';

/**
 * The Host's own ceiling, matching the one the body reader already enforces.
 *
 * Duplicated as a number rather than imported so this module stays free of the
 * HTTP layer; `http-server.ts` is the one place that decides what the wire
 * allows, and the test asserts the two agree.
 */
const HOST_MAX_FILE_BYTES = 32 * 1024 * 1024;

export class HostWorkspaceFileApiError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostWorkspaceFileApiError';
  }
}

export interface HostLocalWorkspaceFileApiV1 {
  readWorkspaceFile(input: HostWorkspaceFileReadInput): Promise<HostWorkspaceFileReadResult>;
}

export interface HostLocalWorkspaceFileApiOptions {
  readonly workspaces: HostWorkspaceAccess;
  /** Overridable so a test can prove the cap is the Host's and not the caller's. */
  readonly maxBytes?: number;
}

export function createHostLocalWorkspaceFileApi(options: HostLocalWorkspaceFileApiOptions): HostLocalWorkspaceFileApiV1 {
  const maxBytes = options.maxBytes ?? HOST_MAX_FILE_BYTES;
  const { workspaces } = options;

  return {
    async readWorkspaceFile(input) {
      const relativePath = input.relativePath.trim();
      if (relativePath.length === 0) {
        throw new HostWorkspaceFileApiError(400, 'invalid_workspace_file_path', 'relativePath must not be empty');
      }
      if (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)) {
        throw new HostWorkspaceFileApiError(400, 'invalid_workspace_file_bytes', 'maxBytes must be a positive integer');
      }

      const resolved = await workspaces.resolvePath?.(input.workspaceId, null, relativePath);
      if (resolved === undefined || resolved === null) {
        throw new HostWorkspaceFileApiError(404, 'workspace_not_found', `workspace ${input.workspaceId} has no readable root`);
      }

      let stats;
      try {
        stats = await fs.stat(resolved);
      } catch {
        // One message for "no such file", "no permission to see it" and "it is
        // not there any more": a reader that distinguishes them can enumerate
        // the tree by asking about paths that do not exist.
        throw new HostWorkspaceFileApiError(404, 'workspace_file_not_found', 'no such file in this workspace');
      }
      if (stats.isDirectory()) {
        throw new HostWorkspaceFileApiError(400, 'workspace_file_is_directory', 'a directory is not a file');
      }
      if (stats.size > maxBytes) {
        throw new HostWorkspaceFileApiError(
          413,
          'workspace_file_too_large',
          `file is ${stats.size} bytes; this Host serves at most ${maxBytes}`,
        );
      }

      // Path-level containment already passed inside the resolver. A symlink is
      // the one way to satisfy it and still leave the tree, so the target is
      // checked separately — and it is the SAME root the resolver used, not a
      // re-derived one.
      const realTarget = await fs.realpath(resolved);
      const realRoot = await fs.realpath(await workspaces.resolvePath?.(input.workspaceId, null, '') ?? resolved);
      if (!isInside(realRoot, realTarget)) {
        throw new HostWorkspaceFileApiError(403, 'workspace_file_outside_root', 'the file resolves outside its workspace');
      }

      const limit = input.maxBytes === undefined ? maxBytes : Math.min(input.maxBytes, maxBytes);
      const handle = await fs.open(realTarget, 'r');
      try {
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buffer, 0, limit, 0);
        return {
          workspaceId: input.workspaceId,
          relativePath,
          totalBytes: stats.size,
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          truncated: bytesRead < stats.size,
        };
      } finally {
        await handle.close();
      }
    },
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export type { HostWorkspaceFileReadInput, HostWorkspaceFileReadResult };
