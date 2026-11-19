/**
 * project-channels-secrets.test.ts — the local credential store cannot be
 * steered by a request and does not follow a planted symlink.
 *
 * The mode assertions are skipped on Windows, where POSIX modes are not the
 * mechanism. That is the same caveat the implementation documents instead of
 * claiming encryption.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectChannelSecretError,
  createProjectChannelSecretStore,
} from '../src/project-channels/secrets.js';

let root: string;
const POSIX = process.platform !== 'win32';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-channel-secrets-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectChannelSecretError);
    return (error as ProjectChannelSecretError).code;
  }
  throw new Error('expected a refusal');
}

describe('connection-scoped secret store', () => {
  it('round-trips, rotates and removes one connection token', async () => {
    const secrets = createProjectChannelSecretStore({ dataRoot: root });
    expect(await secrets.read('conn-1')).toBeNull();
    await secrets.write('conn-1', 'token-one');
    expect(await secrets.read('conn-1')).toBe('token-one');
    await secrets.write('conn-1', 'token-two');
    expect(await secrets.read('conn-1')).toBe('token-two');
    // A second connection is unaffected by the first one's rotation.
    await secrets.write('conn-2', 'other');
    expect(await secrets.read('conn-1')).toBe('token-two');
    await secrets.remove('conn-1');
    expect(await secrets.read('conn-1')).toBeNull();
    expect(await secrets.read('conn-2')).toBe('other');
    // Removing an absent credential is the desired end state, not an error.
    await secrets.remove('conn-1');
  });

  it.runIf(POSIX)('writes a 0600 file inside a 0700 directory', async () => {
    const secrets = createProjectChannelSecretStore({ dataRoot: root });
    await secrets.write('conn-1', 'token');
    const directory = join(root, 'project-channel-secrets');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'conn-1.token')).mode & 0o777).toBe(0o600);
  });

  it('refuses path traversal and unsafe ids', async () => {
    const secrets = createProjectChannelSecretStore({ dataRoot: root });
    for (const id of ['../escape', 'a/b', '..', '.', '', 'x'.repeat(129)]) {
      expect(await codeOf(() => secrets.write(id, 'token'))).toBe('invalid_connection_id');
    }
  });

  it('refuses to read, write or remove through a symlink', async () => {
    const secrets = createProjectChannelSecretStore({ dataRoot: root });
    const directory = join(root, 'project-channel-secrets');
    mkdirSync(directory, { recursive: true });
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'someone-elses-token', 'utf8');
    symlinkSync(outside, join(directory, 'conn-1.token'));

    expect(await codeOf(() => secrets.read('conn-1'))).toBe('unsafe_path');
    expect(await codeOf(() => secrets.write('conn-1', 'overwrite'))).toBe('unsafe_path');
    expect(await codeOf(() => secrets.remove('conn-1'))).toBe('unsafe_path');
    expect(readFileSync(outside, 'utf8')).toBe('someone-elses-token');
  });

  it('refuses an empty token instead of storing a blank credential', async () => {
    const secrets = createProjectChannelSecretStore({ dataRoot: root });
    expect(await codeOf(() => secrets.write('conn-1', '   '))).toBe('write_failed');
    expect(await secrets.read('conn-1')).toBeNull();
  });

  it('keeps the new token when a rotation is interrupted before the rename', async () => {
    // The temp file is the only intermediate state; a reader still sees the
    // previous complete value.
    const secrets = createProjectChannelSecretStore({ dataRoot: root });
    await secrets.write('conn-1', 'stable');
    const directory = join(root, 'project-channel-secrets');
    writeFileSync(join(directory, 'conn-1.token.123.abc.tmp'), 'half', 'utf8');
    expect(await secrets.read('conn-1')).toBe('stable');
  });
});
