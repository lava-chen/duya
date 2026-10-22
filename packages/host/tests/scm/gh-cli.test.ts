import { describe, expect, it } from 'vitest';
import {
  createGhRunner,
  GH_MAX_BUFFER_BYTES,
  GH_TIMEOUT_MS,
  GhError,
  parseGhJson,
  readJsonField,
  resolveGhPath,
  type GhErrorCode,
  type GhExecFile,
} from '../../src/scm/gh-cli.js';

/** Build the kind of rejection `execFile` produces, without spawning anything. */
function spawnFailure(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? 'gh failed')), fields);
}

function runnerWithExec(execFile: GhExecFile, timeoutMs?: number) {
  return createGhRunner({
    execFile,
    resolvePath: () => '/fake/gh',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('resolveGhPath', () => {
  it('prefers a usable DUYA_GH_PATH over PATH', () => {
    const resolved = resolveGhPath({
      env: { DUYA_GH_PATH: '/custom/gh', PATH: '/usr/bin' },
      platform: 'linux',
      isFile: (candidate) => candidate === '/custom/gh' || candidate === '/usr/bin/gh',
    });
    expect(resolved).toBe('/custom/gh');
  });

  it('reports gh_not_found when DUYA_GH_PATH points nowhere, instead of falling back', () => {
    let caught: unknown;
    try {
      resolveGhPath({
        env: { DUYA_GH_PATH: '/missing/gh', PATH: '/usr/bin' },
        platform: 'linux',
        isFile: (candidate) => candidate === '/usr/bin/gh',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GhError);
    expect((caught as GhError).code).toBe('gh_not_found');
    expect((caught as GhError).message).toContain('/missing/gh');
  });

  it('scans PATH with the platform executable suffixes', () => {
    const resolved = resolveGhPath({
      env: { PATH: 'C:\\Windows\\System32;D:\\tools' },
      platform: 'win32',
      isFile: (candidate) => candidate === 'D:\\tools\\gh.exe',
    });
    expect(resolved).toBe('D:\\tools\\gh.exe');
  });

  it('falls back to the Windows install directory when PATH misses it', () => {
    const resolved = resolveGhPath({
      env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      platform: 'win32',
      isFile: (candidate) => candidate === 'C:\\Program Files\\GitHub CLI\\gh.exe',
    });
    expect(resolved).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
  });

  it('falls back to the common POSIX locations', () => {
    const resolved = resolveGhPath({
      env: { PATH: '/nowhere' },
      platform: 'darwin',
      isFile: (candidate) => candidate === '/opt/homebrew/bin/gh',
    });
    expect(resolved).toBe('/opt/homebrew/bin/gh');
  });

  it('throws a typed gh_not_found, never a bare ENOENT', () => {
    let caught: unknown;
    try {
      resolveGhPath({ env: {}, platform: 'linux', isFile: () => false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GhError);
    const failure = caught as GhError;
    expect(failure.code).toBe('gh_not_found');
    expect(failure.message).toContain('DUYA_GH_PATH');
    expect(failure.message).not.toContain('ENOENT');
  });
});

describe('createGhRunner', () => {
  it('invokes gh with an args array and the bounded exec options', async () => {
    const seen: Array<{ file: string; args: string[]; options: unknown }> = [];
    const runner = runnerWithExec(async (file, args, options) => {
      seen.push({ file, args, options });
      return { stdout: 'ok', stderr: '' };
    });

    await expect(runner.run(['pr', 'view', '7', '--repo', 'o/r'])).resolves.toBe('ok');

    expect(seen).toEqual([
      {
        file: '/fake/gh',
        args: ['pr', 'view', '7', '--repo', 'o/r'],
        options: {
          timeout: GH_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: GH_MAX_BUFFER_BYTES,
        },
      },
    ]);
  });

  it('passes cwd through when the caller names one', async () => {
    let captured: unknown;
    const runner = runnerWithExec(async (_file, _args, options) => {
      captured = options;
      return { stdout: '', stderr: '' };
    });

    await runner.run(['pr', 'list'], { cwd: 'C:\\work tree' });
    expect(captured).toMatchObject({ cwd: 'C:\\work tree' });
  });

  it('never spawns when the executable cannot be resolved', async () => {
    const runner = createGhRunner({
      env: {},
      platform: 'linux',
      isFile: () => false,
      execFile: async () => {
        throw new Error('execFile must not be called');
      },
    });

    const error = await runner.run(['pr', 'view', '1']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).code).toBe('gh_not_found');
  });

  it('parses stdout as JSON and narrows the shape', async () => {
    const runner = runnerWithExec(async () => ({ stdout: '{"number":7}', stderr: '' }));
    const parsed = await runner.runJson(['pr', 'view', '7'], (value) => readJsonField(value, 'number'));
    expect(parsed).toBe(7);
  });

  it('reports invalid_json when stdout is not JSON', async () => {
    const runner = runnerWithExec(async () => ({ stdout: 'not json at all', stderr: '' }));
    const error = await runner.runJson(['pr', 'view', '7'], (value) => value).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).code).toBe('invalid_json');
  });

  it('reports invalid_json when the narrowed shape is wrong', async () => {
    const runner = runnerWithExec(async () => ({ stdout: '{"state":42}', stderr: '' }));
    const error = await runner
      .runJson(['pr', 'view', '7'], () => {
        throw new Error('unexpected shape');
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).code).toBe('invalid_json');
  });
});

describe('gh failure classification', () => {
  const rows: Array<{ name: string; error: Error; expected: GhErrorCode }> = [
    {
      name: 'missing binary mid-flight',
      error: spawnFailure({ code: 'ENOENT', message: 'spawn gh ENOENT' }),
      expected: 'gh_not_found',
    },
    {
      name: 'timeout by code',
      error: spawnFailure({ code: 'ETIMEDOUT', killed: true }),
      expected: 'timeout',
    },
    {
      name: 'timeout by kill',
      error: spawnFailure({ killed: true }),
      expected: 'timeout',
    },
    {
      name: 'auth exit code 4',
      error: spawnFailure({
        code: 4,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      }),
      expected: 'not_authenticated',
    },
    {
      name: 'auth by text',
      error: spawnFailure({
        code: 1,
        stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
      }),
      expected: 'not_authenticated',
    },
    {
      name: 'rate limited',
      error: spawnFailure({
        code: 1,
        stderr: 'HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)',
      }),
      expected: 'rate_limited',
    },
    {
      name: 'pull request missing',
      error: spawnFailure({
        code: 1,
        stderr:
          'GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)',
      }),
      expected: 'not_found',
    },
    {
      name: 'unclassified',
      error: spawnFailure({ code: 1, stderr: 'boom: something broke' }),
      expected: 'unknown',
    },
  ];

  for (const row of rows) {
    it(`maps ${row.name} to ${row.expected}`, async () => {
      const runner = runnerWithExec(async () => {
        throw row.error;
      });

      const error = await runner.run(['pr', 'view', '1']).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GhError);
      const failure = error as GhError;
      expect(failure.code).toBe(row.expected);
      expect(failure.message.length).toBeGreaterThan(0);
      // The user-facing sentence must never leak the raw spawn code.
      expect(failure.message).not.toContain('ENOENT');
    });
  }

  it('keeps the diagnostic line for unclassified failures', async () => {
    const runner = runnerWithExec(async () => {
      throw spawnFailure({ code: 1, stderr: 'boom: something broke\nstack line' });
    });
    const error = (await runner.run(['pr', 'view', '1']).catch((caught: unknown) => caught)) as GhError;
    expect(error.message).toContain('boom: something broke');
    expect(error.message).not.toContain('stack line');
  });

  it('names the timeout budget in seconds', async () => {
    const runner = runnerWithExec(async () => {
      throw spawnFailure({ code: 'ETIMEDOUT' });
    }, 5_000);
    const error = (await runner.run(['pr', 'view', '1']).catch((caught: unknown) => caught)) as GhError;
    expect(error.code).toBe('timeout');
    expect(error.message).toContain('5 seconds');
  });
});

describe('parseGhJson helpers', () => {
  it('throws invalid_json on malformed JSON', () => {
    expect(() => parseGhJson('{')).toThrowError(GhError);
  });

  it('reads fields without trusting the input', () => {
    expect(readJsonField({ a: 1 }, 'a')).toBe(1);
    expect(readJsonField(null, 'a')).toBeUndefined();
    expect(readJsonField('text', 'a')).toBeUndefined();
  });
});
