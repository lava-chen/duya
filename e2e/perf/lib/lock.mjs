/**
 * e2e/perf/lib/lock.mjs — the shared measurement lock.
 *
 * Five agents benchmark the same machine at the same time. A CPU, GPU or
 * memory number taken while another agent is building or measuring is a
 * measurement of contention, not of the code under test — so every measured
 * run of this harness is wrapped in a shared lock.
 *
 * THE LOCK IS SELF-CONTAINED
 *
 * The mutex lives HERE: an atomic `mkdir` is the lock, the owner is a small
 * JSON file inside it, and a lock older than the timeout is stale and may be
 * taken over. Nothing outside the repository is required, so a fresh clone
 * on a fresh machine still excludes concurrent measurements.
 *
 * THE EXTERNAL SCRIPT IS AN OPTIONAL OVERRIDE
 *
 * `E:\Projects\duya\.claude\perf-bench-lock.mjs` (and any script passed with
 * `--lock-script` or `DUYA_PERF_LOCK_SCRIPT`) is the same mutex with a
 * command-line interface. It is used when it is CONFIGURED, and — more
 * importantly — its location decides WHERE the shared lock lives, so an
 * agent that uses the in-repo implementation and an agent that uses the
 * script exclude EACH OTHER instead of taking two different locks.
 *
 * Resolution order:
 *
 *   1. `--lock-script <path>`      the external script, used as the mutex
 *   2. `DUYA_PERF_LOCK_SCRIPT`      the same, from the environment
 *   3. the in-repo implementation   the default, with the shared lock dir
 *   4. the default external script  only to LOCATE the shared lock dir
 *
 * The shared lock directory:
 *
 *   `--lock-dir <path>`  →  `DUYA_PERF_LOCK_DIR`  →  `<the external script's
 *   directory>/perf-bench.lock`  →  `<repo>/.claude/perf-bench.lock`
 *
 * The last one is inside the repository, in the gitignored `.claude` area.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repository root of this checkout (e2e/perf/lib -> e2e/perf -> e2e -> root). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** The name of the lock directory. The external script uses the same one. */
export const LOCK_DIR_NAME = 'perf-bench.lock';

/** A lock older than this is stale and may be taken over. */
export const DEFAULT_TIMEOUT_MIN = 30;

/**
 * The external lock script, when one is CONFIGURED.
 *
 * `--lock-script` and `DUYA_PERF_LOCK_SCRIPT` are the override; without
 * them the in-repo implementation is used.
 */
export function resolveLockScript(explicitPath) {
  const candidates = [explicitPath, process.env.DUYA_PERF_LOCK_SCRIPT].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The external script the SPRINT shares, when it is on this machine.
 *
 * It is not used as the mutex here — the in-repo implementation is — but its
 * directory is where the shared lock lives, so that a script-driven agent
 * and an in-repo agent exclude each other.
 */
export function findSharedLockScript() {
  const candidates = [
    path.resolve(REPO_ROOT, '.claude', 'perf-bench-lock.mjs'),
    path.resolve(REPO_ROOT, '..', '..', 'perf-bench-lock.mjs'),
    path.resolve(REPO_ROOT, '..', 'perf-bench-lock.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Where the shared lock lives. */
export function resolveLockDir(options = {}) {
  if (options.lockDir) return path.resolve(options.lockDir);
  if (process.env.DUYA_PERF_LOCK_DIR) return path.resolve(process.env.DUYA_PERF_LOCK_DIR);
  const shared = findSharedLockScript();
  if (shared) return path.join(path.dirname(shared), LOCK_DIR_NAME);
  return path.resolve(REPO_ROOT, '.claude', LOCK_DIR_NAME);
}

/** The owner of a lock, or null when it cannot be read. */
export function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function lockAgeMs(owner) {
  if (!owner || typeof owner.acquiredAt !== 'number') return Number.POSITIVE_INFINITY;
  return Date.now() - owner.acquiredAt;
}

/**
 * Whether the process that took the lock is still running.
 *
 * A crashed holder leaves its lock behind, and the lock is then held by
 * nobody: the sprint stalls until the stale timeout expires, which is 30
 * minutes of a machine that is not being measured at all. A holder whose
 * process is gone therefore never held the lock against anybody.
 *
 * A pid that cannot be checked (no pid in the owner file) counts as alive:
 * an unreadable owner is not evidence that the holder is gone.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

/** A human-readable description of the current holder. */
export function describeLockHolder(lockDir) {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    // The owner file is written right after the directory is created, so a
    // missing one means the lock was taken a moment ago. A fresh directory
    // is NOT stale.
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (age < 60_000) return 'held (owner file not written yet)';
    } catch {
      return 'free';
    }
    return 'held (owner file unreadable)';
  }
  const mins = Math.round(lockAgeMs(owner) / 60000);
  return `held by ${owner.agent} since ${new Date(owner.acquiredAt).toISOString()} (${mins} min)`;
}

/**
 * Take the in-repo lock.
 *
 * `mkdir` is atomic, so exactly one caller creates the directory. The owner
 * file is written immediately afterwards; a lock whose owner file is missing
 * but whose directory is fresh is treated as held, not as stale.
 *
 * A lock is stale when it is older than the timeout OR when the process that
 * took it is gone: a crashed holder leaves a lock that nobody holds, and
 * waiting the whole timeout for it is a stall of the whole sprint.
 */
export function acquireInternalLock(options = {}) {
  const lockDir = options.lockDir ?? resolveLockDir(options);
  const agent = options.agent ?? 'agentA-harness';
  const timeoutMin = options.timeoutMin ?? DEFAULT_TIMEOUT_MIN;

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readLockOwner(lockDir);
    const stale = owner
      ? lockAgeMs(owner) > timeoutMin * 60_000 || !isProcessAlive(owner.pid)
      : isDirectoryStale(lockDir);
    if (!stale) {
      return { acquired: false, lockDir, reason: describeLockHolder(lockDir), holder: owner };
    }
    // A crashed holder must not block the sprint forever.
    releaseInternalLock(lockDir);
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { acquired: false, lockDir, reason: describeLockHolder(lockDir), holder: readLockOwner(lockDir) };
    }
  }

  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ agent, pid: process.pid, acquiredAt: Date.now() }, null, 2),
    'utf8',
  );
  return { acquired: true, lockDir, agent, at: new Date().toISOString() };
}

/** Whether a lock directory without an owner file is old enough to take over. */
function isDirectoryStale(lockDir) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > DEFAULT_TIMEOUT_MIN * 60_000;
  } catch {
    return false;
  }
}

/** Release the in-repo lock. Safe to call when it was never acquired. */
export function releaseInternalLock(lockDir) {
  try {
    fs.unlinkSync(path.join(lockDir, 'owner.json'));
  } catch {
    /* the owner file may already be gone */
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {
    /* the directory may be gone, or not empty */
  }
  return { released: true };
}

/** Who holds the lock right now. */
export function lockStatus(lockDir) {
  if (!fs.existsSync(lockDir)) return 'free';
  return describeLockHolder(lockDir);
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
  const script = options.script ?? null;
  const agent = options.agent ?? 'agentA-harness';
  const waitMs = options.waitMs ?? 0;
  const deadline = Date.now() + waitMs;
  const lockDir = options.lockDir ?? resolveLockDir(options);

  for (;;) {
    const result = script
      ? acquireThroughScript(script, agent)
      : acquireInternalLock({ lockDir, agent, timeoutMin: options.timeoutMin });
    if (result.acquired) {
      // A script-driven acquisition leaves the script's own (already dead) pid
      // in the owner file. Claim it for this process so that the in-repo
      // implementation does not treat the live holder as a crashed one.
      if (script) claimOwnerPid(lockDir, agent);
      return { ...result, script: script ?? null, lockDir };
    }
    if (Date.now() >= deadline) {
      return { acquired: false, reason: result.reason, holder: result.holder ?? null, script, lockDir };
    }
    process.stdout.write(
      `[perf] measurement lock is busy, waiting (${String(result.reason).split('\n')[0] ?? ''})\n`,
    );
    // Poll often: the lock is handed over in the gap between two agents, and
    // a short gap is only won by the agent that asks for it most often.
    sleepSync(options.retryMs ?? 2000);
  }
}

function acquireThroughScript(script, agent) {
  const result = spawnSync(process.execPath, [script, 'acquire', agent], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  if (result.status === 0) return { acquired: true, at: new Date().toISOString() };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { acquired: false, reason: output || 'lock busy' };
}

/**
 * Record THIS process as the owner of a lock that was taken through the
 * external script.
 *
 * The script writes its own pid into `owner.json` and exits immediately, so
 * the recorded pid is already dead by the time the caller continues. The
 * in-repo implementation treats a dead owner as a crashed holder and takes the
 * lock over — which means a script-driven agent and an in-repo agent would
 * measure on the same machine at the same time, and both sets of numbers
 * would be a measurement of contention instead of of the code under test.
 * Writing the caller's live pid back into the owner file keeps the two
 * implementations excluding each other.
 *
 * The takeover of a genuinely crashed holder still works: when the holder
 * dies, its pid dies with it.
 */
function claimOwnerPid(lockDir, agent) {
  try {
    const owner = readLockOwner(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify(
        {
          agent: owner?.agent ?? agent,
          pid: process.pid,
          acquiredAt: owner?.acquiredAt ?? Date.now(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // The owner file is a hint for the takeover rule; the directory itself is
    // the mutex. Failing to refresh it must not fail the acquisition.
  }
}

/** A synchronous sleep — the harness must not yield the process while it waits. */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** Release the lock. Safe to call when it was never acquired. */
export function releaseLock(options = {}) {
  if (options.script) {
    spawnSync(process.execPath, [options.script, 'release'], { encoding: 'utf8', cwd: REPO_ROOT });
    return { released: true };
  }
  return releaseInternalLock(options.lockDir ?? resolveLockDir(options));
}

/**
 * Run `fn` while holding the lock, and always release it.
 *
 * The return value carries whether the measurement actually ran under the
 * lock, so the report can be honest about it.
 */
export async function withMeasurementLock(fn, options = {}) {
  const script = resolveLockScript(options.lockScript);
  const lockDir = resolveLockDir({ lockDir: options.lockDir });
  const acquisition = acquireLock({
    script,
    lockDir,
    agent: options.agent,
    waitMs: options.waitMs ?? 0,
    retryMs: options.retryMs ?? 2000,
  });
  if (!acquisition.acquired) {
    if (options.required) {
      throw new Error(`the measurement lock is held by another agent: ${acquisition.reason}`);
    }
    process.stdout.write(
      `[perf] continuing WITHOUT the measurement lock: ${acquisition.reason}\n`,
    );
    const value = await fn({ held: false, reason: acquisition.reason });
    return {
      value,
      lock: {
        enabled: false,
        held: false,
        reason: acquisition.reason,
        implementation: script ? 'external-script' : 'in-repo',
        dir: lockDir,
      },
    };
  }
  try {
    const value = await fn({ held: true });
    return {
      value,
      lock: {
        enabled: true,
        held: true,
        agent: acquisition.agent,
        at: acquisition.at,
        implementation: script ? 'external-script' : 'in-repo',
        dir: lockDir,
      },
    };
  } finally {
    releaseLock({ script, lockDir });
  }
}
