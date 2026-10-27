/**
 * The Host's runtime descriptor: the small file a client reads to learn which
 * loopback Host is running and how to authenticate to it.
 *
 * ## Why this is its own module
 *
 * `local-host.ts` composes and runs the Host, so it pulls in the whole data
 * layer (`@duya/data`, SQLite, the store family). A client that only wants to
 * READ the descriptor — the Web BFF, the CLI, the TUI — does not need any of
 * that, and importing `local-host.ts` for one function drags the entire Host
 * into the client's module graph.
 *
 * That matters beyond weight: the Web BFF is a plain Node ESM program, and
 * `@duya/plugin-core` (reached through the Host's dist chain) emits
 * extensionless relative specifiers under `moduleResolution: bundler`, which
 * plain Node cannot resolve. So a client that imports the Host's dist chain
 * needs a resolver shim just to boot. Keeping the descriptor reader free of
 * that chain removes the shim from the product path entirely.
 *
 * So the descriptor contract lives HERE, and `local-host.ts` re-exports it.
 * There is one definition of the file format and one definition of its
 * validation, and both a Host that writes it and a client that reads it
 * agree by construction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The Host always binds loopback; a descriptor naming another host is not ours. */
const HOST = '127.0.0.1';

/**
 * The descriptor as the Host writes it.
 *
 * `apiVersion` is fixed at 1 for now: a reader that does not recognize the
 * version must refuse the descriptor rather than guess at its fields.
 */
export interface LocalHostRuntime {
  readonly apiVersion: 1;
  readonly host: typeof HOST;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * Whether a process is still running.
 *
 * `EPERM` means the process exists but belongs to another user — that is
 * still a live Host, so it counts. Any other error means it is gone.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Where the descriptor lives under a data root. */
export function localHostRuntimePath(dataRoot: string): string {
  return path.join(dataRoot, 'runtime', 'host-api.json');
}

/**
 * Read the descriptor of a running local Host.
 *
 * `null` means "no Host is running here" — the file is absent, or it names a
 * process that has exited. A file that exists but is unreadable or malformed
 * is an ERROR, not an absence: those are different facts, and a client that
 * treats a corrupt descriptor as "no Host" would report a missing Host for a
 * Host that is running.
 */
export async function readLocalHostRuntimeFrom(dataRoot: string): Promise<LocalHostRuntime | null> {
  const filePath = localHostRuntimePath(dataRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read Duya Host runtime descriptor: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Duya Host runtime descriptor is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.apiVersion !== 1 || value.host !== HOST ||
    typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    typeof value.token !== 'string' || value.token.length === 0 ||
    typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt)
  ) {
    throw new Error('Duya Host runtime descriptor has invalid fields');
  }
  return isPidAlive(value.pid) ? value as unknown as LocalHostRuntime : null;
}
