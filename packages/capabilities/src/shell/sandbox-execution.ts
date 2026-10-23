/**
 * The one place that decides how a shell command is isolated.
 *
 * ## Why this module exists
 *
 * The sandbox adapter has had `wrapCommand` and `executeIsolated` since the
 * beginning, and NOTHING in production called them: the shell tools execute
 * through the injected `ShellCommandRuntimePorts`, and the host's shell worker
 * spawned the command directly. So the system enabled the sandbox, prewarmed a
 * container image, and then ran every command with no OS isolation at all.
 *
 * That is a missing wire, not a degraded mode, and a missing wire cannot be
 * fixed by a warning. This module is the wire: the shell path asks it what to
 * run, and it answers with the command to spawn AND the isolation level that
 * command actually got.
 *
 * ## Why the answer carries its own reason
 *
 * `provider: 'none'` is not an error — it is the truth on a host with no
 * bubblewrap. But a truth that arrives without a reason reads like a bug, and
 * a truth that is not recorded at all reads like a guarantee. So the plan
 * carries `isolated` and `reason` together, and the caller is expected to
 * surface them rather than swallow them.
 */

import { resolveShellIsolationSync, wrapCommandSync, type ShellIsolation } from '@duya/sandbox';

/** What the shell path decided to run, and under what isolation. */
export interface ShellExecutionPlan {
  /** The command to spawn. Wrapped when an OS sandbox is in force. */
  readonly command: string;
  /** The isolation the command actually got. */
  readonly isolation: ShellIsolation;
  /** One line a user can read, saying what happened. */
  readonly diagnostic: string;
}

/**
 * Describe an isolation level in one line.
 *
 * The wording is deliberately plain. "Runs unwrapped" is a fact; "sandbox
 * disabled" would be a diagnosis this function is not qualified to make.
 */
export function describeShellIsolation(isolation: ShellIsolation): string {
  if (isolation.isolated) {
    return `Command sandbox: ${isolation.provider} — ${isolation.reason}.`;
  }
  return `Command sandbox: none — ${isolation.reason}. Only the path and permission policies apply; there is no OS isolation for this command.`;
}

/**
 * Plan a shell command: what to run, and under what isolation.
 *
 * The command is wrapped only when an OS sandbox is actually available. A
 * provider that is merely PRESENT is not applied here: wrapping a command
 * cannot create a container, so the plan reports the level the command really
 * gets rather than the level the host could offer.
 */
export function planShellExecution(params: {
  readonly command: string;
  readonly cwd: string;
}): ShellExecutionPlan {
  const isolation = resolveShellIsolationSync();
  const command = isolation.provider === 'bubblewrap'
    ? wrapCommandSync(params.command, params.cwd)
    : params.command;
  return { command, isolation, diagnostic: describeShellIsolation(isolation) };
}
