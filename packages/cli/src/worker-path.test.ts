import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHostWorkerPath } from './worker-path.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('resolveHostWorkerPath', () => {
  it('uses the explicit Host worker path when configured', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', path.join('relative', 'worker.js'));
    const existsSync = vi.spyOn(fs, 'existsSync');

    expect(resolveHostWorkerPath()).toBe(path.resolve('relative', 'worker.js'));
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('discovers the Host bundle under the workspace packages directory', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', ' ');
    const expected = path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js');
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => String(candidate) === expected);

    expect(resolveHostWorkerPath()).toBe(expected);
  });

  it('leaves execution disabled when the Host bundle is absent', () => {
    vi.stubEnv('DUYA_HOST_WORKER_PATH', '');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    expect(resolveHostWorkerPath()).toBeUndefined();
  });
});
