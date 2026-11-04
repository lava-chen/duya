import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  localHostRuntimePath,
  readLocalHostRuntimeFrom,
} from '../src/host-runtime.js';

/**
 * The descriptor reader is the one piece of the Host a plain Node client
 * imports, so its CONTRACT is worth pinning on its own: a client that cannot
 * tell "no Host is running" from "the descriptor is broken" will report a
 * missing Host for a Host that is running.
 */
describe('Host runtime descriptor', () => {
  async function withDataRoot(run: (dataRoot: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-runtime-'));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  async function writeDescriptor(dataRoot: string, value: unknown): Promise<void> {
    const filePath = localHostRuntimePath(dataRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value));
  }

  it('reports no Host when the descriptor is absent', async () => {
    await withDataRoot(async (dataRoot) => {
      await expect(readLocalHostRuntimeFrom(dataRoot)).resolves.toBeNull();
    });
  });

  it('reads the descriptor of a live Host', async () => {
    await withDataRoot(async (dataRoot) => {
      const descriptor = {
        apiVersion: 1,
        host: '127.0.0.1',
        port: 62373,
        token: 'descriptor-token',
        pid: process.pid,
        startedAt: 1_700_000_000_000,
      };
      await writeDescriptor(dataRoot, descriptor);

      await expect(readLocalHostRuntimeFrom(dataRoot)).resolves.toEqual(descriptor);
    });
  });

  it('reports no Host when the descriptor names a process that has exited', async () => {
    await withDataRoot(async (dataRoot) => {
      // A pid that cannot be running: the descriptor exists and is well
      // formed, but the Host behind it is gone.
      await writeDescriptor(dataRoot, {
        apiVersion: 1,
        host: '127.0.0.1',
        port: 62373,
        token: 'descriptor-token',
        pid: 2 ** 30,
        startedAt: 1_700_000_000_000,
      });

      await expect(readLocalHostRuntimeFrom(dataRoot)).resolves.toBeNull();
    });
  });

  it('refuses a malformed descriptor instead of reporting no Host', async () => {
    await withDataRoot(async (dataRoot) => {
      // Each of these is a descriptor that cannot be trusted. Reading one
      // must FAIL, not resolve to null: null means "no Host", and a client
      // that said that here would send the user looking for a Host that runs.
      const broken: readonly unknown[] = [
        { apiVersion: 2, host: '127.0.0.1', port: 1, token: 't', pid: process.pid, startedAt: 1 },
        { apiVersion: 1, host: '0.0.0.0', port: 1, token: 't', pid: process.pid, startedAt: 1 },
        { apiVersion: 1, host: '127.0.0.1', port: 0, token: 't', pid: process.pid, startedAt: 1 },
        { apiVersion: 1, host: '127.0.0.1', port: 70000, token: 't', pid: process.pid, startedAt: 1 },
        { apiVersion: 1, host: '127.0.0.1', port: 1, token: '', pid: process.pid, startedAt: 1 },
        { apiVersion: 1, host: '127.0.0.1', port: 1, token: 't', pid: 0, startedAt: 1 },
        { apiVersion: 1, host: '127.0.0.1', port: 1, token: 't', pid: process.pid, startedAt: 'soon' },
        'not an object',
      ];

      for (const descriptor of broken) {
        await writeDescriptor(dataRoot, descriptor);
        await expect(readLocalHostRuntimeFrom(dataRoot)).rejects.toThrow(/runtime descriptor/);
      }
    });
  });

  it('refuses a descriptor that is not valid JSON', async () => {
    await withDataRoot(async (dataRoot) => {
      const filePath = localHostRuntimePath(dataRoot);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '{ not json');

      await expect(readLocalHostRuntimeFrom(dataRoot)).rejects.toThrow(/runtime descriptor/);
    });
  });
});
