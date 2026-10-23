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
 * product concern), so its path is overridable:
 *
 *   node e2e/perf/agents/agent-d/run-with-lock.mjs --lock <path> -- --mode all --repeats 3
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK = 'E:/Projects/duya/.claude/perf-bench-lock.mjs';

function parseArgs(argv) {
  const args = { lock: DEFAULT_LOCK, agent: 'agentD-gpu', harnessArgs: [], waitMinutes: 40 };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === '--lock') args.lock = argv[++i];
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
  if (!fs.existsSync(args.lock)) {
    throw new Error(`lock script not found: ${args.lock}`);
  }

  const deadline = Date.now() + args.waitMinutes * 60_000;
  let acquired = false;
  while (Date.now() < deadline) {
    const attempt = runLock(args.lock, 'acquire', [args.agent]);
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

  try {
    const harness = path.join(HERE, 'gpu-observability.mjs');
    const child = spawn(process.execPath, [harness, ...args.harnessArgs], {
      stdio: 'inherit',
      cwd: path.resolve(HERE, '..', '..', '..', '..'),
    });
    const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)));
    process.exitCode = code;
  } finally {
    // Release even when the harness failed: a stale lock blocks the sprint.
    const release = runLock(args.lock, 'release');
    process.stdout.write(release.stdout.trim());
  }
}

main().catch((err) => {
  process.stderr.write(`[agent-d] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
