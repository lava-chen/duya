/**
 * packages/agent/src/tool/DuyaCliTool/runner.ts
 *
 * In-process invocation of CLI control-plane commands.
 *
 * The `run*` functions in `cli/commands/*.ts` write to
 * `process.stdout` / `process.stderr` directly. To use them inside
 * the agent (without spawning a subprocess and re-doing auth), we
 * temporarily swap those streams for `Writable` instances that
 * accumulate chunks, then restore them.
 *
 * Subprocess is *not* used. The agent process is the desktop
 * process; userData is the same. This is the same code path the
 * external CLI takes, with the only difference being that the IPC
 * is in-process.
 *
 * Plan 98: dispatch goes through the descriptor-driven
 * `buildAgentRunner()` (same registry as the CLI bundle). The
 * legacy hand-rolled `switch (inv.command)` chain was removed.
 */

import { Writable } from 'node:stream';
import { buildAgentRunner, type CliInvocation, type CliRunResult } from '../../cli/program/build-agent-runner.js';

export type { CliInvocation, CliRunResult };

/**
 * Capture process.stdout / process.stderr for the duration of `fn`,
 * restoring the originals on completion (success or failure).
 */
async function captureStreams<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  // Patch process.stdout.write / process.stderr.write so any
  // `process.stdout.write(...)` call inside the run* functions ends
  // up in our chunks, not on the agent's real TTY.
  (process.stdout as unknown as { write: (b: unknown) => boolean }).write = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      outChunks.push(Buffer.from(chunk, 'utf-8'));
    } else if (Buffer.isBuffer(chunk)) {
      outChunks.push(chunk);
    } else {
      outChunks.push(Buffer.from(String(chunk), 'utf-8'));
    }
    return true;
  };
  (process.stderr as unknown as { write: (b: unknown) => boolean }).write = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      errChunks.push(Buffer.from(chunk, 'utf-8'));
    } else if (Buffer.isBuffer(chunk)) {
      errChunks.push(chunk);
    } else {
      errChunks.push(Buffer.from(String(chunk), 'utf-8'));
    }
    return true;
  };

  // Some callers also probe `.isTTY` etc. We do not mock those;
  // the run* functions are written to be safe under non-TTY
  // conditions (the CLI bundle runs in headless test environments).

  try {
    const value = await fn();
    return {
      value,
      stdout: Buffer.concat(outChunks).toString('utf-8'),
      stderr: Buffer.concat(errChunks).toString('utf-8'),
    };
  } finally {
    (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
    (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
  }
}

// Build the shared resolver once at module load. It is pure data
// (no I/O), so doing this eagerly is safe and avoids per-invocation
// overhead.
const resolve = buildAgentRunner();

/**
 * Dispatch the parsed invocation to the matching run* function.
 * Returns a structured result; never throws (failures are encoded
 * as non-zero exit codes, mirroring the CLI bundle contract).
 */
export async function runCliCommand(inv: CliInvocation): Promise<CliRunResult> {
  // We need a `runner` callback that returns a number; buildAgentRunner
  // returns the exit code directly. Capture its result by wrapping in
  // a no-op function so captureStreams still works.
  const runner = async (): Promise<number> => {
    const r = await resolve(inv);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return r.exitCode;
  };

  try {
    const { value, stdout, stderr } = await captureStreams(runner);
    return { exitCode: value, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `internal error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
