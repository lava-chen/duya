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
 * The split is real rather than a hiding place — the gate scans `chat.ts`, and
 * the value import it used to reject (`@duya/host/local-host` → run-execution →
 * run-orchestrator → `@duya/agent-runtime`) is now reachable only from this
 * file and from `index.ts`, which is also a bootstrap. Note what this does NOT
 * buy: `duya tui` still runs the engine locally, because that is what starting
 * an ephemeral Host means. What it buys is that `chat.ts` is now a client that
 * a remote surface can be modelled on.
 */

import type { SessionId } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost } from '@duya/host/local-host';
import { resolveHostWorkerPath } from './worker-path.js';
import { captureConsoleToFile } from './tui/console-capture.js';
import { chatInteractive, createChatSession, write, DIM, RED, RESET } from './chat.js';
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

/**
 * Entry for the `duya tui` command. Starts an ephemeral Host and opens the TUI
 * in the same process, unless {@link attachedHostFromEnv} says to attach to a
 * Host that is already running. The started Host is shut down when the TUI
 * exits; an attached one is not this process's to close. Which screen model
 * that TUI uses is `inlineTuiRequested`; this entry point is the same either
 * way. Returns the process exit code.
 */
export async function runTuiCommand(options: TuiCommandOptions): Promise<number> {
  const host = attachedHostFromEnv(process.env) ?? await startLocalHost({
    port: options.port,
    ephemeral: true,
    workerPath: resolveHostWorkerPath(),
  });
  const client = new HostSessionHttpClient(host.origin, host.token ?? '');
  try {
    const health = await client.getHealth();
    write(`${DIM}duya tui · Host ${host.origin} (api v${health.apiVersion})${RESET}`);
  } catch (error) {
    write(`${RED}Host failed to start: ${error instanceof Error ? error.message : String(error)}${RESET}`);
    return 1;
  }

  let sessionId: SessionId;
  const owned = new OwnedSessions();
  if (options.session !== undefined && options.session.trim().length > 0) {
    sessionId = options.session.trim() as SessionId;
    const existing = await client.readLocalSession(sessionId, { includeAllSessions: true });
    if (existing === null) {
      write(`${RED}session ${sessionId} does not exist on this Host${RESET}`);
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
      await host.close();
    } finally {
      consoleCapture?.restore();
    }
  }
  return exitCode;
}
