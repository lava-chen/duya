/**
 * secrets.ts — the Host's connection-scoped credential store.
 *
 * ## What this is NOT
 *
 * It is not a keychain, and it does not pretend to be one. Tokens land in a
 * permission-restricted file under the Host's own data root; the directory is
 * created 0700 and the file 0600 where the platform honours modes. On a
 * platform that ignores modes this is a plaintext file behind whatever ACL the
 * user's profile already has, and the honest documentation says so rather than
 * claiming encryption.
 *
 * ## Why the path is not a parameter
 *
 * A secret path that a request could choose is a request that can read another
 * connection's token, or `../../..` something else. So the only input is a
 * connection id, it is validated against a narrow pattern, and the resulting
 * path is checked to still sit directly inside the secret directory. An
 * existing symlink is refused instead of followed — a symlink planted in the
 * directory would otherwise redirect both read and write.
 *
 * ## Rotation is atomic
 *
 * Writing goes to a fresh temporary file in the same directory and renames it
 * over the target, so a crash leaves either the old token or the new one, never
 * half of each. `remove` is a real unlink of the file this store owns.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The Host-facing port. The composition root injects an implementation. */
export interface ProjectChannelSecretPort {
  /** The stored token, or null when this connection has no credential. */
  read(connectionId: string): Promise<string | null>;
  /** Atomically replace the token. */
  write(connectionId: string, token: string): Promise<void>;
  /** Forget the token. Missing is not an error. */
  remove(connectionId: string): Promise<void>;
}

export type ProjectChannelSecretErrorCode = 'invalid_connection_id' | 'unsafe_path' | 'write_failed';

export class ProjectChannelSecretError extends Error {
  constructor(readonly code: ProjectChannelSecretErrorCode, message: string) {
    super(message);
    this.name = 'ProjectChannelSecretError';
  }
}

export interface ProjectChannelSecretStoreOptions {
  /** The Host's data root; the secret directory is created underneath it. */
  readonly dataRoot: string;
  /** Subdirectory name, overridable so tests can assert the layout. */
  readonly directory?: string;
}

const SAFE_CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_DIRECTORY = 'project-channel-secrets';
const FILE_SUFFIX = '.token';

/**
 * Local file implementation. Synchronous `fs` calls: a token read/write is one
 * small file, and making it async would only let two rotations interleave in
 * the same process for no benefit.
 */
export function createProjectChannelSecretStore(
  options: ProjectChannelSecretStoreOptions,
): ProjectChannelSecretPort {
  const directory = path.resolve(options.dataRoot, options.directory ?? DEFAULT_DIRECTORY);

  function secretPath(connectionId: string): string {
    if (!SAFE_CONNECTION_ID.test(connectionId) || connectionId === '.' || connectionId === '..') {
      throw new ProjectChannelSecretError('invalid_connection_id', 'connection id is not a safe file name');
    }
    const resolved = path.resolve(directory, `${connectionId}${FILE_SUFFIX}`);
    if (path.dirname(resolved) !== directory) {
      throw new ProjectChannelSecretError('unsafe_path', 'secret path escaped its directory');
    }
    return resolved;
  }

  function ensureDirectory(): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      // `mkdir` does not tighten an existing directory; a data root created by
      // an older version may be world-readable.
      fs.chmodSync(directory, 0o700);
    } catch {
      // A platform that ignores modes is documented, not silently "fixed".
    }
  }

  function refuseSymlink(filePath: string): void {
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) {
        throw new ProjectChannelSecretError('unsafe_path', 'secret file is a symlink');
      }
    } catch (error) {
      if (error instanceof ProjectChannelSecretError) throw error;
      // ENOENT: nothing there yet, which is the normal case.
    }
  }

  return {
    async read(connectionId) {
      const filePath = secretPath(connectionId);
      refuseSymlink(filePath);
      let text: string;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
      const token = text.trim();
      return token === '' ? null : token;
    },

    async write(connectionId, token) {
      const value = token.trim();
      if (value === '') {
        throw new ProjectChannelSecretError('write_failed', 'token must not be empty');
      }
      const filePath = secretPath(connectionId);
      ensureDirectory();
      refuseSymlink(filePath);
      const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch { /* Best-effort cleanup of our own temp file. */ }
        if (error instanceof ProjectChannelSecretError) throw error;
        throw new ProjectChannelSecretError('write_failed', 'could not persist the connection token');
      }
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Same platform caveat as the directory mode above.
      }
    },

    async remove(connectionId) {
      const filePath = secretPath(connectionId);
      refuseSymlink(filePath);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Removing an absent credential is the desired end state.
      }
    },
  };
}

/** In-memory port for tests and for a Host that must not persist credentials. */
export function createInMemoryProjectChannelSecrets(
  initial: Readonly<Record<string, string>> = {},
): ProjectChannelSecretPort {
  const tokens = new Map<string, string>(Object.entries(initial));
  return {
    async read(connectionId) {
      return tokens.get(connectionId) ?? null;
    },
    async write(connectionId, token) {
      tokens.set(connectionId, token);
    },
    async remove(connectionId) {
      tokens.delete(connectionId);
    },
  };
}
