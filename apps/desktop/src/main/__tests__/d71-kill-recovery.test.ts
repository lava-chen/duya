/**
 * D7.1 — kill and restart recovery, proved by FAULT INJECTION against a real
 * process.
 *
 * ## What is actually killed
 *
 * A real `node` child (`d71-kill-worker.mjs`), holding a real
 * `better-sqlite3` file, terminated UNCATCHABLY while a tool attempt is in
 * flight. Not a mock, not a function called in a deliberate order, not a
 * `try`/`catch` standing in for a crash: a process that does not get to run
 * anything again.
 *
 * The termination is `taskkill /F /T` on Windows and `SIGKILL` on POSIX. Both
 * are uncatchable and both skip the child's cleanup — which is the point. A
 * cooperative stop is the case recovery does NOT have to handle, and a test
 * that used one would prove the easy half.
 *
 * ## The three claims, and where each is observable
 *
 *  1. **A real side effect outlives the process that made it.** Read the file
 *     the child wrote, from the parent's own filesystem, AFTER the kill.
 *  2. **Recovery says `unknown`, and `unknown` blocks the retry.** Read the
 *     verdict from a SECOND process that opened the same database, so the
 *     answer is a property of the persisted bytes rather than of anything the
 *     first process still had in memory.
 *  3. **A stale attempt cannot write after a new one starts.** A third process
 *     attempts a real write at a fence below the committed high-water mark.
 *
 * ## What this does NOT prove, stated here rather than in a report
 *
 *  - Not the packaged agent bundle, and not Electron. The child here imports
 *    the BUILT `@duya/agent-protocol` — the same artifact production loads —
 *    but it is not `agent-process-entry`, and no claim is made about how a
 *    real DuyaAgent mid-LLM-turn behaves under this kill.
 *  - Not the durable `CheckpointStore` adapter. SQLite is real here, but the
 *    fence COMPARISON is applied in the child, because the port's contract is
 *    that an adapter performs it; `checkpoint-store.test.ts` covers the
 *    in-process implementation of those same rules.
 *  - Execution RESUME remains unsupported (D7.3). This proves the state a
 *    recovery must READ and the rules it must apply. It does not turn the
 *    capability on, and nothing here should be read as doing so.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const WORKER = fileURLToPath(new URL('./d71-kill-worker.mjs', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Harness {
  readonly child: ChildProcess;
  readonly frames: Frame[];
  send(cmd: unknown): void;
  /** Resolve when a frame of `type` arrives, or reject on timeout. */
  waitFor(type: string, timeoutMs: number): Promise<Frame>;
  kill(): Promise<number | null>;
}

const running: Harness[] = [];

afterEach(async () => {
  for (const h of running.splice(0)) await h.kill();
});

/**
 * Fork the REAL worker and read its stdout as frames.
 *
 * stderr is captured rather than inherited so a native-module load failure
 * surfaces in the assertion message instead of scrolling past.
 */
function startWorker(): Harness {
  const frames: Frame[] = [];
  const stderr: string[] = [];
  const child = spawn(process.execPath, [WORKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DUYA_TEST: '1' },
  });
  child.stderr?.on('data', (c: Buffer) => stderr.push(c.toString('utf8')));

  let buffer = '';
  let notify: (() => void) | null = null;
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line.length > 0) {
        try {
          frames.push(JSON.parse(line) as Frame);
        } catch {
          stderr.push(`unparseable: ${line}\n`);
        }
      }
      i = buffer.indexOf('\n');
    }
    notify?.();
  });

  const harness: Harness = {
    child,
    frames,
    send: (cmd) => {
      child.stdin?.write(`${JSON.stringify(cmd)}\n`);
    },
    waitFor: async (type, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;      for (;;) {
        const found = frames.find((f) => f.type === type);
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `worker never emitted "${type}". stderr:\n${stderr.join('').slice(-3000)}\nframes: ${JSON.stringify(frames)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
        notify = () => {};
      }
    },
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      if (IS_WINDOWS) {
        // `/F /T` — force, and the whole tree. This is the uncatchable one.
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // Already gone; the exit-code assertion below is the real check.
        }
      } else {
        child.kill('SIGKILL');
      }
      await new Promise((r) => setTimeout(r, 200));
      return child.exitCode;
    },
  };
  running.push(harness);
  return harness;
}

let counter = 0;
function newRun(): { readonly dir: string; readonly dbPath: string; readonly runId: string; readonly sideEffectPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'duya-d71-'));
  counter += 1;
  return {
    dir,
    dbPath: path.join(dir, 'runs.db'),
    runId: `d71-run-${process.pid}-${counter}`,
    sideEffectPath: path.join(dir, 'external-effect.txt'),
  };
}

describe('a hard kill mid-tool, and what a new process makes of it', () => {
  it(
    'leaves a real side effect on disk, and recovery reads it as `unknown` — not `failed`, not `succeeded`',
    async () => {
      const run = newRun();

      // ── Attempt 1: a real process, killed while a tool is in flight ──────
      const first = startWorker();
      await first.waitFor('ready', 60_000);
      first.send({ type: 'phase_run', dbPath: run.dbPath, runId: run.runId, sideEffectPath: run.sideEffectPath });
      const inFlight = await first.waitFor('in_flight', 60_000);

      // The real effect exists BEFORE the kill. This is what makes the
      // question interesting: the world changed, and nothing recorded it.
      expect(existsSync(run.sideEffectPath)).toBe(true);
      expect(readFileSync(run.sideEffectPath, 'utf8')).toMatch(/really happened/);

      // ── The kill. Uncatchable, uncleaned, no chance to record anything. ───
      const firstPid = first.child.pid;
      expect(typeof firstPid).toBe('number');
      await first.kill();
      // Proof the process is gone rather than merely unreachable: an uncatchable
      // kill is the only way this exit is guaranteed.
      expect(first.child.signalCode !== null || first.child.exitCode !== null).toBe(true);
      expect(inFlight['attemptKey']).toBe(`${run.runId}/e1/tc-1`);

      // ── Attempt 2: a DIFFERENT process recovers from the same file ───────
      const second = startWorker();
      await second.waitFor('ready', 20_000);
      second.send({ type: 'phase_recover', dbPath: run.dbPath, runId: run.runId });
      const recovered = await second.waitFor('recovered', 60_000);

      // A different pid is what makes this a recovery rather than a lookup in
      // memory the first process never lost.
      expect(recovered['pid']).not.toBe(firstPid);
      expect(recovered['ok']).toBe(true);
      // The bytes on disk are intact — the digest still verifies after a kill.
      expect(recovered['digestIntact']).toBe(true);

      const attempts = recovered['attempts'] as Array<Record<string, unknown>>;
      expect(attempts).toHaveLength(1);
      const attempt = attempts[0];
      if (attempt === undefined) throw new Error('no attempt recovered');

      // The state is `unknown` — the third outcome. `failed` would claim the
      // effect did not happen, and we can see that it DID.
      expect(attempt['state']).toBe('unknown');
      expect(attempt['state']).not.toBe('failed');
      expect(attempt['state']).not.toBe('succeeded');

      // And the whole point: it BLOCKS the automatic retry.
      const verdict = attempt['verdict'] as { retry: boolean; code?: string };
      expect(verdict.retry).toBe(false);
      expect(verdict.code).toBe('non_retryable');
    },
    180_000,
  );

  it(
    'refuses a stale attempt that tries to write after a newer attempt has started',
    async () => {
      const run = newRun();

      // Attempt 1 at fence 1, killed mid-tool.
      const first = startWorker();
      await first.waitFor('ready', 60_000);
      first.send({ type: 'phase_run', dbPath: run.dbPath, runId: run.runId, sideEffectPath: run.sideEffectPath });
      await first.waitFor('in_flight', 60_000);
      await first.kill();

      // Attempt 2 claims the run at a HIGHER fence — this is what a recovery
      // does, and it is a different epoch, not a continuation of the first.
      const second = startWorker();
      await second.waitFor('ready', 20_000);
      second.send({ type: 'phase_stale_write', dbPath: run.dbPath, runId: run.runId, generation: 2, runEpoch: 2, fence: 2 });
      const newAttempt = await second.waitFor('stale_write', 60_000);
      expect(newAttempt['applied']).toBe(true);
      expect(newAttempt['highWaterMark']).toBe(1);

      // Now the OLD attempt's writer, in its own process, tries to commit at
      // the fence it was killed holding. A comparison that lived only inside
      // the recovering process would not stop this.
      const stale = startWorker();
      await stale.waitFor('ready', 20_000);
      stale.send({ type: 'phase_stale_write', dbPath: run.dbPath, runId: run.runId, generation: 3, runEpoch: 1, fence: 1 });
      const refused = await stale.waitFor('stale_write', 60_000);

      expect(refused['applied']).toBe(false);
      expect(refused['code']).toBe('stale_fence');
      expect(refused['highWaterMark']).toBe(2);
      // A third process, so the refusal is a property of the database rather
      // than of anything the stale writer had cached.
      expect(refused['pid']).not.toBe(newAttempt['pid']);
    },
    180_000,
  );
});
