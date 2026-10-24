/**
 * `duya tui` starting a Host it can share.
 *
 * ## The property worth guarding
 *
 * A second terminal must end up talking to the SAME Host as the first one.
 * The mechanism is deliberately "wait for a descriptor", not "wait for my
 * child": when two terminals start at the same moment, the Host process lock
 * lets only one win and the loser has to attach to the winner instead of
 * failing. A launcher that insisted on its own child would break exactly
 * there — the case a user hits by opening two windows quickly.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackgroundHost } from '../tui/background-host.js';

const temporaryRoots: string[] = [];
const spawnedPids = new Set<number>();

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  spawnedPids.clear();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'duya-background-host-'));
  temporaryRoots.push(root);
  return root;
}

/**
 * A stand-in for `duya serve --client-scoped`.
 *
 * It behaves like the real thing where it matters: the first one to arrive
 * publishes the descriptor, every later one finds the directory taken and
 * leaves it alone. The published pid is its own, so the descriptor looks like
 * a live Host.
 */
async function fakeHostEntry(root: string): Promise<string> {
  const entry = join(root, 'fake-serve.mjs');
  await writeFile(
    entry,
    [
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const root = process.env.DUYA_DATA_ROOT;",
      'const descriptor = join(root, "runtime", "host-api.json");',
      'if (existsSync(descriptor)) process.exit(0);',
      'mkdirSync(join(root, "runtime"), { recursive: true });',
      'writeFileSync(descriptor, JSON.stringify({',
      '  apiVersion: 1, host: "127.0.0.1", port: 8710, token: "fake-host-token",',
      "  pid: process.pid, startedAt: Date.now(),",
      '}));',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1 << 30);',
    ].join('\n'),
    'utf8',
  );
  return entry;
}

/** A stand-in that starts and publishes nothing. */
async function silentEntry(root: string): Promise<string> {
  const entry = join(root, 'silent.mjs');
  await writeFile(entry, 'process.exit(0);\n', 'utf8');
  return entry;
}

describe('startBackgroundHost', () => {
  it('publishes a Host this terminal can attach to, without claiming to own it', async () => {
    const root = await temporaryRoot();
    vi.stubEnv('DUYA_DATA_ROOT', root);
    const entry = await fakeHostEntry(root);

    const host = await startBackgroundHost({ dataRoot: root, entry, timeoutMs: 15_000 });

    expect(host.origin).toBe('http://127.0.0.1:8710');
    expect(host.token).toBe('fake-host-token');
    expect(host.pid).toBeGreaterThan(0);
    spawnedPids.add(host.pid);
    // The background Host is not this process's to close.
    expect(host.started).toBe(false);
    await expect(host.close()).resolves.toBeUndefined();
  });

  it('gives a second caller the same Host instead of a second one', async () => {
    const root = await temporaryRoot();
    vi.stubEnv('DUYA_DATA_ROOT', root);
    const entry = await fakeHostEntry(root);

    const first = await startBackgroundHost({ dataRoot: root, entry, timeoutMs: 15_000 });
    const second = await startBackgroundHost({ dataRoot: root, entry, timeoutMs: 15_000 });
    spawnedPids.add(first.pid);

    expect(second.origin).toBe(first.origin);
    expect(second.pid).toBe(first.pid);
  });

  it('says where to look when the Host never publishes itself', async () => {
    const root = await temporaryRoot();
    vi.stubEnv('DUYA_DATA_ROOT', root);
    const entry = await silentEntry(root);

    await expect(startBackgroundHost({ dataRoot: root, entry, timeoutMs: 1_000 })).rejects.toThrow(
      /did not start within 1s/,
    );
  });

  it('sends the Host output to a log file, so a failure leaves a trace', async () => {
    const root = await temporaryRoot();
    vi.stubEnv('DUYA_DATA_ROOT', root);
    const entry = await fakeHostEntry(root);

    const host = await startBackgroundHost({ dataRoot: root, entry, timeoutMs: 15_000 });
    spawnedPids.add(host.pid);

    const logPath = join(root, 'logs', 'background-host.log');
    expect(existsSync(logPath)).toBe(true);
    // The file is opened for appending, so the Host writes into it.
    expect(typeof await readFile(logPath, 'utf8')).toBe('string');
  });
});
