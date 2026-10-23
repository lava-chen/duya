/**
 * e2e/perf/lib/lock.mjs — the shared measurement lock.
 *
 * Five agents benchmark the same machine at the same time. A CPU, GPU or
 * memory number taken while another agent is building or measuring is a
 * measurement of contention, not of the code under test — so every measured
 * run of this harness is wrapped in the shared lock.
 *
 * The lock script lives outside the repository (it is shared infrastructure
 * between the agents, not a product file). Its location is configurable:
 *
 *   --lock-script <path>          command line
 *   DUYA_PERF_LOCK_SCRIPT <path>  environment
 *   <repo>/../../perf-bench-lock.mjs, then <repo>/perf-bench-lock.mjs
 *
 * When no script can be found the harness still runs, and the report records
 * `lock.enabled = false` with the reason — a report that says it was taken
 * without the lock is better than a report that pretends otherwise.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from './launch.mjs';

/** Find the lock script, or null when there is none. */
export function resolveLockScript(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.DUYA_PERF_LOCK_SCRIPT,
    path.resolve(REPO_ROOT, '..', '..', 'perf-bench-lock.mjs'),
    path.resolve(REPO_ROOT, 'perf-bench-lock.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Acquire the lock.
 *
 * Returns `{ acquired: true }` when the lock is held, or
 * `{ acquired: false, reason, holder }` when another agent holds it and the
 * wait budget ran out. The harness NEVER measures without the lock when the
 * lock is available — it waits instead.
 */
export function acquireLock(options = {}) {
  const script = options.script;
  if (!script) return { acquired: false, reason: 'no lock script found' };
  const agent = options.agent ?? 'agentA-harness';
  const waitMs = options.waitMs ?? 0;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const result = spawnSync(process.execPath, [script, 'acquire', agent], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    if (result.status === 0) {
      return { acquired: true, script, agent, at: new Date().toISOString() };
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (Date.now() >= deadline) {
      return { acquired: false, reason: output || 'lock busy', script, agent };
    }
    process.stdout.write(
      `[perf] measurement lock is busy, waiting (${output.split('\n')[0] ?? ''})\n`,
    );
    spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', cwd: REPO_ROOT });
    // Sleep synchronously: the harness is a sequential script.
    sleepSync(15_000);
  }
}

/** A synchronous sleep — the harness must not yield the process while it waits. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** Release the lock. Safe to call when it was never acquired. */
export function releaseLock(options = {}) {
  if (!options.script) return { released: false };
  spawnSync(process.execPath, [options.script, 'release'], { encoding: 'utf8', cwd: REPO_ROOT });
  return { released: true };
}

/** Read the current holder, for the report. */
export function lockStatus(script) {
  if (!script) return null;
  const result = spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', cwd: REPO_ROOT });
  const output = `${result.stdout ?? ''}`.trim();
  return output || null;
}

/**
 * Run `fn` while holding the lock, and always release it.
 *
 * The return value carries whether the measurement actually ran under the
 * lock, so the report can be honest about it.
 */
export async function withMeasurementLock(fn, options = {}) {
  const script = resolveLockScript(options.lockScript);
  const acquisition = acquireLock({
    script,
    agent: options.agent,
    waitMs: options.waitMs ?? 0,
  });
  if (!acquisition.acquired) {
    if (options.required) {
      throw new Error(`the measurement lock is held by another agent: ${acquisition.reason}`);
    }
    process.stdout.write(
      `[perf] continuing WITHOUT the measurement lock: ${acquisition.reason}\n`,
    );
    const value = await fn({ held: false, reason: acquisition.reason });
    return { value, lock: { enabled: false, held: false, reason: acquisition.reason } };
  }
  try {
    const value = await fn({ held: true });
    return { value, lock: { enabled: true, held: true, agent: acquisition.agent, at: acquisition.at } };
  } finally {
    releaseLock({ script });
  }
}
