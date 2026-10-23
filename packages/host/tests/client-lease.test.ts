import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientLeaseTracker } from '../src/client-lease.js';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

describe('ClientLeaseTracker', () => {
  it('is idle from the start, so a Host nobody attaches to gives up', () => {
    let now = 1_000;
    const tracker = new ClientLeaseTracker({ idleTimeoutMs: 500, now: () => now });

    expect(tracker.isIdle()).toBe(false);
    now = 1_500;
    expect(tracker.isIdle()).toBe(true);
  });

  it('is not idle while a client holds a lease, however long the client is busy', () => {
    let now = 1_000;
    const tracker = new ClientLeaseTracker({ idleTimeoutMs: 500, now: () => now });
    tracker.acquire();

    // A client streaming a long turn sends no requests at all. Judging
    // liveness by request frequency would declare it gone here.
    now = 100_000;
    expect(tracker.isIdle()).toBe(false);
    expect(tracker.leaseCount).toBe(1);
  });

  it('stays alive while any client remains, and idles only after the last one leaves', () => {
    let now = 1_000;
    const tracker = new ClientLeaseTracker({ idleTimeoutMs: 500, now: () => now });
    tracker.acquire();
    tracker.acquire();

    tracker.release();
    now = 5_000;
    expect(tracker.isIdle()).toBe(false);

    tracker.release();
    // The clock restarts when the LAST lease goes, so the Host does not
    // decide to exit on a client that just left.
    expect(tracker.isIdle()).toBe(false);
    now = 5_500;
    expect(tracker.isIdle()).toBe(true);
  });

  it('ignores a release that never had a lease', () => {
    const tracker = new ClientLeaseTracker({ idleTimeoutMs: 0, now: () => 0 });

    tracker.release();

    expect(tracker.leaseCount).toBe(0);
    expect(tracker.isIdle()).toBe(true);
  });
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await exists(filePath))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('client-scoped Host', () => {
  it('stops on its own once the last client leaves, and releases the data directory', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-lease-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    const runtimeFilePath = path.join(dataRoot, 'runtime', 'host-api.json');
    let host: LocalHostHandle | undefined;

    try {
      host = await startLocalHost({
        dataRoot,
        databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
        rolloutRoot: path.join(dataRoot, 'sessions'),
        attachmentsRoot: path.join(dataRoot, 'attachments'),
        runtimeFilePath,
        port: 0,
        token: 'client-lease-test-token',
        clientScoped: true,
        clientLeaseIdleTimeoutMs: 300,
      });
      const client = new HostSessionHttpClient(host.origin, 'client-lease-test-token');

      const lease = await client.openClientLease();
      expect(lease).not.toBeNull();
      expect(await exists(runtimeFilePath)).toBe(true);

      lease?.close();

      // The Host notices on its own. Nothing asked it to stop.
      expect(await waitUntilGone(runtimeFilePath, 15_000)).toBe(true);
      // The handle is already closed; closing it again is a no-op.
      await expect(host.close()).resolves.toBeUndefined();
      host = undefined;
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('stays up while another client is still attached', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-lease-two-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    const runtimeFilePath = path.join(dataRoot, 'runtime', 'host-api.json');
    let host: LocalHostHandle | undefined;

    try {
      host = await startLocalHost({
        dataRoot,
        databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
        rolloutRoot: path.join(dataRoot, 'sessions'),
        attachmentsRoot: path.join(dataRoot, 'attachments'),
        runtimeFilePath,
        port: 0,
        token: 'client-lease-two-token',
        clientScoped: true,
        clientLeaseIdleTimeoutMs: 300,
      });
      const first = new HostSessionHttpClient(host.origin, 'client-lease-two-token');
      const second = new HostSessionHttpClient(host.origin, 'client-lease-two-token');
      const firstLease = await first.openClientLease();
      const secondLease = await second.openClientLease();

      firstLease?.close();
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // One client left, so the Host must still be there.
      expect(await exists(runtimeFilePath)).toBe(true);

      secondLease?.close();
      expect(await waitUntilGone(runtimeFilePath, 15_000)).toBe(true);
      host = undefined;
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('offers no lease on a Host that is not client-scoped', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-no-lease-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    let host: LocalHostHandle | undefined;

    try {
      host = await startLocalHost({
        dataRoot,
        databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
        rolloutRoot: path.join(dataRoot, 'sessions'),
        attachmentsRoot: path.join(dataRoot, 'attachments'),
        runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
        port: 0,
        token: 'no-lease-token',
      });
      const client = new HostSessionHttpClient(host.origin, 'no-lease-token');

      // Such a Host runs until somebody stops it, so there is nothing to hold.
      await expect(client.openClientLease()).resolves.toBeNull();
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
