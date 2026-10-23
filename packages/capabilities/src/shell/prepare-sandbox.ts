/**
 * Worker-side sandbox preparation.
 *
 * ## What this used to claim
 *
 * The previous version called `setSandboxEnabled(true)` and then prewarmed a
 * Docker image in the background, swallowing every error. That made the worker
 * LOOK sandboxed: the flag was on, an image was being built, and no command
 * was ever routed through either. The image prewarm was also work for a path
 * nobody took — the shell execution path applies bubblewrap, not Docker — and
 * it ran on every worker start.
 *
 * ## What it does now
 *
 * It resolves the isolation level the shell path can actually deliver, and it
 * REPORTS it. The diagnostic goes out through the caller's progress channel,
 * which is the agent process's own log — so the level a run gets is on the
 * record next to the run, not only in a source comment.
 */

import { resolveShellIsolationSync, setSandboxEnabled, type ShellIsolation } from '@duya/sandbox';
import { describeShellIsolation } from './sandbox-execution.js';

/** What the worker resolved about its own isolation. */
export interface WorkerSandboxPreparation {
  /** The isolation level the shell execution path will apply. */
  readonly isolation: ShellIsolation;
  /** The same statement, in one line, for the log. */
  readonly diagnostic: string;
}

/**
 * Enable command sandboxing and report the level that is actually in force.
 *
 * The Docker image prewarm is gone on purpose: the shell path applies
 * bubblewrap, and building a container image for a path no command takes
 * cost a docker build on every worker start while proving nothing.
 */
export function prepareWorkerSandbox(reportProgress: (message: string) => void): WorkerSandboxPreparation {
  setSandboxEnabled(true);
  const isolation = resolveShellIsolationSync();
  const diagnostic = describeShellIsolation(isolation);
  reportProgress(diagnostic);
  return { isolation, diagnostic };
}
