import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCliApiRuntime } from './runtime-config.js';

describe('readCliApiRuntime', () => {
  let dataRoot: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  });

  it('reads the local service discovery file from the shared data root', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'duya-cli-runtime-'));
    vi.stubEnv('DUYA_DATA_ROOT', dataRoot);
    vi.stubEnv('DUYA_CLI_USER_DATA_DIR', '');
    vi.stubEnv('DUYA_TEST', '');
    vi.stubEnv('DUYA_TEST_NAMESPACE', '');

    const runtimePath = join(dataRoot, 'runtime', 'cli-api.json');
    await mkdir(join(dataRoot, 'runtime'), { recursive: true });
    await writeFile(
      runtimePath,
      JSON.stringify({ port: 43127, token: 'test-token', pid: process.pid, startedAt: 1 }),
      'utf8',
    );

    await expect(readCliApiRuntime()).resolves.toMatchObject({
      kind: 'ok',
      runtime: { port: 43127, token: 'test-token', pid: process.pid },
      runtimePath,
    });
  });
});
