/**
 * background-host.ts — start a Host that outlives the terminal that asked for it.
 *
 * ## Why this exists
 *
 * `duya tui` used to boot an *ephemeral* Host inside its own process. That Host
 * took the data directory's database lock but published no runtime descriptor,
 * so the state was "owned by somebody nobody can find": a second terminal
 * found no Host to attach to, started its own, and died with
 * `DatabaseOwnerLockError`.
 *
 * The fix is not a weaker lock. It is a Host that *publishes itself*: a real
 * `duya serve` process, started in the background, which writes the runtime
 * descriptor and is therefore attachable by every other client. One Host, one
 * event bus, several terminals — the same shape the Desktop already has.
 *
 * ## Why a separate process
 *
 * A Host inside the TUI dies with the TUI. A terminal that another terminal
 * depends on cannot be tied to the first one's lifetime, so the Host gets its
 * own process and the TUI becomes a client of it.
 *
 * ## The race between two terminals
 *
 * Two terminals starting at the same moment both find no descriptor and both
 * try to start a Host. The Host process lock (`runtime/host.lock`) lets only
 * one win, and the loser exits. That is not an error: both terminals wait for
 * a descriptor rather than for their own child, so the loser simply attaches
 * to the winner. This is why the wait below is "a descriptor appeared", not
 * "my child is still running".
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalHostRuntime } from '@duya/host/local-host';
import { resolveDataRoot } from '@duya/data';
import type { DiscoveredHost } from '../tui-command.js';

export interface BackgroundHostOptions {
  /** Data directory the Host owns. Defaults to the resolved data root. */
  readonly dataRoot?: string;
  /** Loopback port the Host should listen on. 0 or absent means "pick one". */
  readonly port?: number;
  /** How long to wait for the Host to publish a descriptor. */
  readonly timeoutMs?: number;
  /** How often to look for the descriptor while waiting. */
  readonly pollIntervalMs?: number;
  /** Where the Host's own output goes. Defaults to `<dataRoot>/logs/background-host.log`. */
  readonly logPath?: string;
  /**
   * The CLI entry point to start the Host from.
   *
   * Defaults to this CLI. It exists so a test can stand a Host up without
   * re-executing the whole bundle.
   */
  readonly entry?: string;
}

/** How long to wait for a background Host to come up. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How often to look for the runtime descriptor while waiting. */
const DEFAULT_POLL_INTERVAL_MS = 200;

/**
 * Start a background Host and wait until it publishes its descriptor.
 *
 * The returned Host is NOT owned by this process: closing it does nothing.
 * The Host stops itself once its last client disconnects, which is what keeps
 * it from outliving the windows that use it.
 */
export async function startBackgroundHost(options: BackgroundHostOptions = {}): Promise<DiscoveredHost> {
  const entry = options.entry ?? resolveCliEntryPath();
  if (entry === undefined) {
    throw new Error('Could not locate the Duya CLI entry point to start a background Host');
  }
  const dataRoot = options.dataRoot;
  const logPath = options.logPath ?? defaultLogPath(dataRoot);
  const logFd = logPath === undefined ? undefined : openLogFd(logPath);
  const args = [entry, 'serve', '--client-scoped'];
  if (options.port !== undefined && options.port > 0) args.push('--port', String(options.port));
  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      // The Host's own output goes to a log file: a background process has no
      // terminal to print to, and a failure that leaves no trace is a failure
      // nobody can act on.
      stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    });
  } finally {
    // The child has its own copy of the descriptor now.
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd);
      } catch {
        // A descriptor that cannot be closed is not worth failing over.
      }
    }
  }
  // The Host has to survive this terminal, so it is not tied to it.
  child.unref();
  void child.on('error', () => {
    // A spawn failure shows up as "no descriptor appeared"; the wait below
    // turns it into an actionable message.
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runtime = await readRuntime(dataRoot);
    if (runtime !== null) {
      return {
        origin: `http://${runtime.host}:${runtime.port}`,
        token: runtime.token,
        close: async () => {},
        started: false,
        pid: runtime.pid,
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The Duya Host did not start within ${Math.round(timeoutMs / 1000)}s.`
        + (logPath === undefined ? '' : ` See ${logPath} for its output.`),
      );
    }
    await delay(pollIntervalMs);
  }
}

/** Read the runtime descriptor, treating an unreadable one as "not there yet". */
async function readRuntime(dataRoot: string | undefined): Promise<Awaited<ReturnType<typeof readLocalHostRuntime>>> {
  try {
    return await readLocalHostRuntime(dataRoot);
  } catch {
    // A half-written descriptor is not evidence of a running Host. The wait
    // continues; the owner-lock error names the real owner if there is one.
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Where the background Host's output goes, so a failure is diagnosable. */
function defaultLogPath(dataRoot: string | undefined): string | undefined {
  try {
    return path.join(dataRoot ?? resolveDataRoot(), 'logs', 'background-host.log');
  } catch {
    return undefined;
  }
}

/** Open the background Host's log file for appending. */
function openLogFd(logPath: string): number | undefined {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    return fs.openSync(logPath, 'a');
  } catch {
    return undefined;
  }
}

/**
 * Locate the CLI entry point a background Host can be started from.
 *
 * The lookup is anchored on this module's own location rather than on
 * `process.argv[1]`, because the entry is what has to be re-executed and the
 * argument vector is not a reliable description of it.
 */
function resolveCliEntryPath(): string | undefined {
  const moduleDir = moduleDirOfThisFile();
  if (moduleDir !== undefined) {
    // The CJS bundle names itself `cli.cjs`; the ESM build's entry is the
    // sibling `index.js`.
    const bundle = path.join(moduleDir, 'cli.cjs');
    if (fs.existsSync(bundle)) return bundle;
    const dist = path.join(moduleDir, 'index.js');
    if (fs.existsSync(dist)) return dist;
  }
  const entry = process.argv[1];
  if (entry !== undefined && entry.length > 0) {
    const resolved = path.resolve(entry);
    if (fs.existsSync(resolved)) return resolved;
  }
  return undefined;
}

function moduleDirOfThisFile(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}
