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

  it('keeps the lease across collector pressure — a lease is a held response, not a forgotten one', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-lease-gc-'));
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
        token: 'client-lease-gc-token',
        clientScoped: true,
        clientLeaseIdleTimeoutMs: 800,
      });
      const client = new HostSessionHttpClient(host.origin, 'client-lease-gc-token');
      const lease = await client.openClientLease();
      expect(lease).not.toBeNull();

      // Allocation churn in the window. Before the fix, `openClientLease`
      // let the lease Response go out of scope; when the collector reclaims
      // it, undici's fetch finalizer aborts the request and the connection
      // drops, which the Host reads as "last client gone" — the 2026-10-25
      // incident that killed a mid-turn worker. Reclamation is deferred
      // rather than immediate (NODE_DEBUG=undici shows `request errored`
      // about eight seconds after the reference is dropped in a plain
      // script), and its cadence varies by environment, so this test is a
      // tripwire rather than a proof: on the fixed client it passes
      // deterministically, on a regressed one it fails whenever the
      // collector fires inside the window.
      let sink: number[][] = [];
      for (let round = 0; round < 5; round += 1) {
        sink = [];
        for (let i = 0; i < 1_200; i += 1) sink.push(new Array<number>(8_192).fill(i));
      }
      sink = [];

      // Longer than the idle timeout: a dropped lease stops the Host and
      // removes the runtime file within it.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      expect(await exists(runtimeFilePath)).toBe(true);

      lease?.close();
      expect(await waitUntilGone(runtimeFilePath, 15_000)).toBe(true);
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

  it('tells the holder when the Host ends the lease, and stays quiet on a deliberate close', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-lease-lost-'));
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
        token: 'lease-lost-token',
        clientScoped: true,
        // Long enough that nothing the test does by itself triggers idle.
        clientLeaseIdleTimeoutMs: 60_000,
      });
      const client = new HostSessionHttpClient(host.origin, 'lease-lost-token');

      const deliberate = await client.openClientLease();
      expect(deliberate).not.toBeNull();
      deliberate!.close();
      expect(await Promise.race([
        deliberate!.lost,
        new Promise((resolve) => setTimeout(() => resolve('still held'), 500)),
      ])).toBe('still held');

      // A lease the Host tears down is a loss: the holder has to know, because
      // the Host's idle countdown started the moment it happened.
      const held = await client.openClientLease();
      expect(held).not.toBeNull();
      await host.close();
      host = undefined;
      await expect(held!.lost).resolves.toEqual(expect.any(String));
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
