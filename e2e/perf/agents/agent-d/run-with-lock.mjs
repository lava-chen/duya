#!/usr/bin/env node
/**
 * run-with-lock.mjs — take the shared measurement lock, run the harness, release.
 *
 * Every agent in the performance sprint benchmarks the same machine. A
 * measurement taken while another agent is building is a measurement of
 * contention, not of the code under test. This wrapper makes the protocol
 * impossible to forget:
 *
 *   1. wait until the shared lock is free (or steal it if it went stale),
 *   2. acquire it,
 *   3. run `gpu-observability.mjs`,
 *   4. release it - including when the run FAILS, because a crashed run that
 *      holds the lock blocks every other agent for the next 30 minutes.
 *
 * The lock script lives outside the repository (it is a sprint artefact, not a
 * product concern), so its path is resolved in this order:
 *
 *   --lock-script <path>          command line (canonical)
 *   --lock <path>                 command line (legacy alias)
 *   DUYA_PERF_LOCK_SCRIPT <path>  environment (canonical)
 *   DUYA_PERF_BENCH_LOCK <path>   environment (legacy alias)
 *   <repo>/.claude/perf-bench-lock.mjs
 *   <repo>/perf-bench-lock.mjs
 *   <repo>/../perf-bench-lock.mjs
 *   <repo>/../../perf-bench-lock.mjs
 *
 * When no script can be found the run STILL HAPPENS: the wrapper prints a
 * warning that the numbers are 未持锁测量 (taken WITHOUT the measurement lock)
 * and hands the harness `lock.enabled = false` with the reason, so the result
 * file says so. A report that admits it was taken without the lock is better
 * than a report that pretends otherwise.
 *
 * USAGE
 *
 *   node e2e/perf/agents/agent-d/run-with-lock.mjs -- --mode all --repeats 3
 *   node e2e/perf/agents/agent-d/run-with-lock.mjs --lock-script <path> -- --mode all
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * Find the lock script, or null when there is none.
 *
 * The order matches the shared harness (`e2e/perf/lib/lock.mjs`): command
 * line, environment, then the repository-relative candidates. The legacy
 * names (`--lock`, `DUYA_PERF_BENCH_LOCK`) are kept as aliases so an older
 * invocation keeps working.
 */
function resolveLockScript(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.DUYA_PERF_LOCK_SCRIPT,
    process.env.DUYA_PERF_BENCH_LOCK,
    path.join(REPO_ROOT, '.claude', 'perf-bench-lock.mjs'),
    path.join(REPO_ROOT, 'perf-bench-lock.mjs'),
    path.join(REPO_ROOT, '..', 'perf-bench-lock.mjs'),
    path.join(REPO_ROOT, '..', '..', 'perf-bench-lock.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseArgs(argv) {
  const args = { lockScript: null, agent: 'agentD-gpu', harnessArgs: [], waitMinutes: 40 };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === '--lock-script' || flag === '--lock') args.lockScript = argv[++i];
    else if (flag === '--agent') args.agent = argv[++i];
    else if (flag === '--wait-minutes') args.waitMinutes = Number(argv[++i]);
    else if (flag === '--') {
      args.harnessArgs = argv.slice(i + 1);
      break;
    } else {
      args.harnessArgs.push(flag);
    }
    i += 1;
  }
  return args;
}

function runLock(lockScript, command, extra = []) {
  const result = spawnSync(process.execPath, [lockScript, command, ...extra], {
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const lockScript = resolveLockScript(args.lockScript);
  let acquired = false;
  let lockState;

  if (!lockScript) {
    const reason =
      'no measurement lock script found (looked at --lock-script, DUYA_PERF_LOCK_SCRIPT, ' +
      'DUYA_PERF_BENCH_LOCK and the repository-relative candidates)';
    lockState = { enabled: false, held: false, agent: args.agent, reason };
    process.stderr.write(
      `[agent-d] WARNING: 未持锁测量 — ${reason}. The numbers in the result file are NOT contention-free.\n`,
    );
  } else {
    const deadline = Date.now() + args.waitMinutes * 60_000;
    while (Date.now() < deadline) {
      const attempt = runLock(lockScript, 'acquire', [args.agent]);
      process.stdout.write(attempt.stdout.trim());
      if (attempt.code === 0) {
        acquired = true;
        break;
      }
      // Exit code 2 means another agent holds it. Wait and retry.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    if (!acquired) {
      throw new Error(`could not acquire the measurement lock within ${args.waitMinutes} minutes`);
    }
    lockState = {
      enabled: true,
      held: true,
      agent: args.agent,
      script: lockScript,
      at: new Date().toISOString(),
    };
  }

  try {
    const harness = path.join(HERE, 'gpu-observability.mjs');
    const child = spawn(process.execPath, [harness, ...args.harnessArgs], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      // The harness records the lock state in its result file, so the report
      // says whether the numbers were taken under the lock.
      env: { ...process.env, DUYA_PERF_LOCK_STATE: JSON.stringify(lockState) },
    });
    const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)));
    process.exitCode = code;
  } finally {
    if (acquired) {
      // Release even when the harness failed: a stale lock blocks the sprint.
      const release = runLock(lockScript, 'release');
      process.stdout.write(release.stdout.trim());
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[agent-d] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
