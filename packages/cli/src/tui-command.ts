/**
 * packages/cli/src/tui-command.ts — `duya tui`: the Host bootstrap.
 *
 * ## Why this file exists at all
 *
 * `chat.ts` is the chat CLIENT entry. It talks to a Host over the versioned
 * HTTP API and nothing else, and `scripts/architecture/client-closure-gate.mjs`
 * (gate G11-1) walks its value-import closure to keep it that way — a client
 * that drags the execution engine into its own process cannot become the thing
 * a web or desktop client copies.
 *
 * `duya tui` is not a client, though. It BOOTS one: it starts an ephemeral Host
 * in the same process and then hands an HTTP client to the TUI. That is server
 * bootstrap, so it lives here, behind the entry the gate watches, instead of
 * being welded into the client module.
 *
 * It only boots one when no Host is running. When the Desktop app (or
 * `duya serve`) already owns this data directory, the TUI attaches to that
 * Host instead — the same process cannot own the database twice.
 *
 * The split is real rather than a hiding place — the gate scans `chat.ts`, and
 * the value import it used to reject (`@duya/host/local-host` → run-execution →
 * run-orchestrator → `@duya/agent-runtime`) is now reachable only from this
 * file and from `index.ts`, which is also a bootstrap. Note what this does NOT
 * buy: `duya tui` still runs the engine locally, because that is what starting
 * an ephemeral Host means. What it buys is that `chat.ts` is now a client that
 * a remote surface can be modelled on.
 */

import type { SessionId } from '@duya/agent-protocol';
import type { HostClientLease, HostHandshakeV1 } from '@duya/host/http-client';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { readLocalHostRuntime, startLocalHost } from '@duya/host/local-host';
import { DatabaseOwnerLockError } from '@duya/data';
import { resolveHostWorkerPath } from './worker-path.js';
import { captureConsoleToFile } from './tui/console-capture.js';
import { startBackgroundHost } from './tui/background-host.js';
import { chatInteractive, createChatSession, write, DIM, RED, RESET } from './chat.js';
import {
  CLI_HOST_DECLARATION,
  HOST_RUN_EXECUTION_CAPABILITY,
  describeRefusal,
} from './host-capability-gate.js';
import { OwnedSessions } from './owned-sessions.js';

export interface TuiCommandOptions {
  readonly port?: number;
  readonly session?: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
}

/** The Host the TUI talks to, however it came to be running. */
export interface AttachedHost {
  readonly origin: string;
  readonly token: string;
  close(): Promise<void>;
  /** Absent when this process did not start the Host. */
  readonly diagnosticsLogPath?: string;
  /** False for an attached Host, which this process must not shut down. */
  readonly started: boolean;
}

/**
 * Attach to an ALREADY RUNNING Host instead of starting an ephemeral one.
 *
 * `runTuiCommand` otherwise always calls `startLocalHost`, which spawns a real
 * worker — fine for a person at a terminal, fatal for an automated one: there
 * is no way to point the TUI at a Host the test controls, so every acceptance
 * run would need real credentials and a real agent turn.
 *
 * ## Why the opt-in is a separate flag
 *
 * Reading the origin alone would make a stray environment variable silently
 * change what `duya tui` does — it would attach to someone else's Host instead
 * of starting its own, and the only symptom would be a session that is not
 * where the user expects. So attaching requires `DUYA_TUI_ATTACH=1` as well:
 * the two variables together are a decision, one on its own is not.
 *
 * ## What an attached Host does not have
 *
 * No `diagnosticsLogPath`. That file is written by the process that STARTED the
 * Host, and this process did not, so pointing at it would be a guess. Console
 * capture is simply not installed in that case.
 */
export function attachedHostFromEnv(env: NodeJS.ProcessEnv): AttachedHost | null {
  if (env.DUYA_TUI_ATTACH !== '1') return null;
  const origin = env.DUYA_TUI_HOST_ORIGIN?.trim() ?? '';
  if (origin === '') {
    throw new Error('DUYA_TUI_ATTACH=1 requires DUYA_TUI_HOST_ORIGIN to name a Host, e.g. http://127.0.0.1:8710');
  }
  return {
    origin,
    token: env.DUYA_TUI_HOST_TOKEN?.trim() ?? '',
    close: async () => {},
    started: false,
  };
}

/** An attached Host the descriptor named, so the refusal can also report its PID. */
export interface DiscoveredHost extends AttachedHost {
  readonly pid: number;
}

/**
 * Attach to the Host that already owns this data directory, if any.
 *
 * `~/.duya/runtime/host-api.json` is written by whoever started the Host — the
 * Desktop app, or `duya serve` — and `readLocalHostRuntime` already rejects a
 * descriptor whose PID is gone. That is the whole point: the Desktop app holds
 * `DatabaseOwnerLock` while it runs, so starting an ephemeral Host here would
 * fail with `DatabaseOwnerLockError` instead of giving the user a second
 * client. Attaching makes the TUI a client of the Host that already exists.
 *
 * Unlike {@link attachedHostFromEnv}, this is not an operator override: it is
 * the normal path, so no environment variable opts in.
 */
export async function attachedHostFromRuntime(dataRoot?: string): Promise<DiscoveredHost | null> {
  let runtime: Awaited<ReturnType<typeof readLocalHostRuntime>>;
  try {
    runtime = await readLocalHostRuntime(dataRoot);
  } catch (error) {
    // A half-written or corrupt descriptor is not evidence of a running Host.
    // Starting one is still correct, and if a PID really does own the
    // database the owner-lock error names it.
    write(`${DIM}Ignoring unreadable Duya Host descriptor: ${errorMessage(error)}${RESET}`);
    return null;
  }
  if (runtime === null) return null;
  return {
    origin: `http://${runtime.host}:${runtime.port}`,
    token: runtime.token,
    close: async () => {},
    started: false,
    pid: runtime.pid,
  };
}

/**
 * Why the TUI must not talk to this discovered Host, or `null` when it can.
 *
 * Two refusals matter. An unanswered origin means the descriptor is not stale
 * by PID but the HTTP surface is gone, so booting a Host here only trades this
 * message for an owner-lock error. A Host without `agent_run_execution` is
 * worse: attachment would succeed and then the first turn would fail on
 * `agent_run_execution_unavailable`. Both are answered before a session is
 * created, not after the user typed a message.
 */
export async function discoveredHostRefusal(host: DiscoveredHost): Promise<string | null> {
  const client = new HostSessionHttpClient(host.origin, host.token);
  let handshake: HostHandshakeV1;
  try {
    handshake = await client.handshake(CLI_HOST_DECLARATION);
  } catch (error) {
    return `a Duya Host (pid ${host.pid}) owns this data directory but ${host.origin} is not answering: ${errorMessage(error)}. Stop that process, or set DUYA_DATA_ROOT to run the TUI on its own data directory`;
  }
  if (handshake.provides?.includes(HOST_RUN_EXECUTION_CAPABILITY) === true) return null;
  return `${describeRefusal(handshake, HOST_RUN_EXECUTION_CAPABILITY)}. That Host (pid ${host.pid}) owns the database, so the TUI cannot start its own; quit it, or set DUYA_DATA_ROOT to run the TUI on its own data directory`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Entry for the `duya tui` command. Opens the TUI against the Host that owns
 * this data directory, starting an ephemeral Host only when none is running.
 *
 * Discovery goes through {@link attachedHostFromRuntime}; the environment
 * override in {@link attachedHostFromEnv} wins when it is set. A discovered
 * Host is not this process's to close, and the same is true of an overridden
 * one; only the ephemeral Host is shut down on exit. Which screen model the TUI
 * uses is `inlineTuiRequested`; this entry point is the same either way.
 * Returns the process exit code.
 */
export async function runTuiCommand(options: TuiCommandOptions): Promise<number> {
  const explicit = attachedHostFromEnv(process.env);
  const discovered = explicit === null ? await attachedHostFromRuntime() : null;
  if (discovered !== null) {
    const refusal = await discoveredHostRefusal(discovered);
    if (refusal !== null) {
      write(`${RED}${refusal}${RESET}`);
      return 1;
    }
  }

  let host: AttachedHost;
  try {
    host = explicit ?? discovered ?? await acquireHost(options);
  } catch (error) {
    write(`${RED}${hostUnavailableMessage(error)}${RESET}`);
    return 1;
  }

  const client = new HostSessionHttpClient(host.origin, host.token ?? '');
  try {
    const health = await client.getHealth();
    write(`${DIM}duya tui · Host ${host.origin} (api v${health.apiVersion})${RESET}`);
  } catch (error) {
    write(`${RED}Host failed to start: ${error instanceof Error ? error.message : String(error)}${RESET}`);
    return 1;
  }

  // Keep the Host alive for as long as this terminal is open. A Host whose
  // clients all left releases the data directory and goes away; without this
  // lease it would take the next terminal down with it.
  const lease = await openClientLease(client);

  let sessionId: SessionId;
  const owned = new OwnedSessions();
  if (options.session !== undefined && options.session.trim().length > 0) {
    sessionId = options.session.trim() as SessionId;
    const existing = await client.readLocalSession(sessionId, { includeAllSessions: true });
    if (existing === null) {
      write(`${RED}session ${sessionId} does not exist on this Host${RESET}`);
      lease?.close();
      return 1;
    }
  } else {
    const created = await createChatSession(client, { ...options, origin: host.origin, token: host.token });
    sessionId = created.id;
    owned.own(created.id);
  }

  let exitCode = 0;
  // From here the TUI owns this terminal. `blessed` renders through its own
  // writer, so any `console.*` call from this process lands inline in the
  // transcript and buries the turn the user asked for. Route it to the Host's
  // diagnostics log for the rest of the TUI's life. `process.stdout` and
  // `process.stderr` are deliberately NOT patched —that is what blessed draws.
  const consoleCapture =
    host.diagnosticsLogPath === undefined
      ? undefined
      : captureConsoleToFile(host.diagnosticsLogPath);
  try {
    exitCode = await chatInteractive(client, sessionId, { ...options, origin: host.origin, token: host.token, diagnosticsLogPath: host.diagnosticsLogPath }, owned);
  } finally {
    try {
      lease?.close();
      await host.close();
    } finally {
      consoleCapture?.restore();
    }
  }
  return exitCode;
}

/**
 * Get a Host for this terminal.
 *
 * The preferred answer is a Host that already runs: the Desktop's, or a
 * `duya serve` somebody started. When there is none, this terminal starts one
 * **as its own process** — not inside this process — so a second terminal can
 * attach to it instead of colliding with it.
 *
 * The in-process Host is the last resort. It works, but it owns the data
 * directory alone, so no other terminal can attach to it. That is the shape
 * that made a second `duya tui` fail with a database lock error, and it is
 * only reached when the background Host could not be started at all.
 */
async function acquireHost(options: TuiCommandOptions): Promise<AttachedHost> {
  try {
    return await startBackgroundHost({
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error) {
    write(`${DIM}Could not start a Duya Host in the background: ${errorMessage(error)}${RESET}`);
  }
  write(`${DIM}Starting a Host inside this terminal; other terminals cannot attach to it.${RESET}`);
  const handle = await startLocalHost({
    port: options.port,
    ephemeral: true,
    workerPath: resolveHostWorkerPath(),
  });
  return {
    origin: handle.origin,
    token: handle.token ?? '',
    close: () => handle.close(),
    ...(handle.diagnosticsLogPath === undefined ? {} : { diagnosticsLogPath: handle.diagnosticsLogPath }),
    started: true,
  };
}

/**
 * Hold a client lease so the Host knows this terminal is still here.
 *
 * A Host that does not offer leases is somebody else's to stop, so there is
 * nothing to hold and nothing to report.
 */
async function openClientLease(client: HostSessionHttpClient): Promise<HostClientLease | null> {
  try {
    return await client.openClientLease();
  } catch {
    return null;
  }
}

/**
 * The message a user gets when no Host could be started.
 *
 * The raw `DatabaseOwnerLockError` names the owner and says nothing about
 * what to do about it. What to do is either stop that program or run this
 * terminal on a data directory of its own.
 */
function hostUnavailableMessage(error: unknown): string {
  if (error instanceof DatabaseOwnerLockError) {
    return [
      `The Duya data directory is already owned by another Duya process (pid ${error.ownerPid} on ${error.ownerHostname}).`,
      'Stop that process, or give this terminal its own data directory:',
      '  DUYA_DATA_ROOT=<somewhere-else> duya tui',
    ].join('\n');
  }
  return `Could not start a Duya Host: ${errorMessage(error)}`;
}
