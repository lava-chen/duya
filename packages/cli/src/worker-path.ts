import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the Host worker entry used by both `duya serve` and `duya tui`.
 *
 * ## Why the lookup is anchored on the CLI's own location
 *
 * The previous implementation only looked under `process.cwd()`. That works
 * when the CLI is launched from a checkout root and silently fails everywhere
 * else: a Host started from a different working directory found no worker and
 * started in LEDGER-ONLY mode, which means no `agent_run_execution`
 * capability, which means every client refuses to attach to it.
 *
 * A Host is now also started as a background process by `duya tui`, and a
 * background process must not depend on the terminal's working directory. So
 * the CLI install location is tried first, and the working directory is only
 * the last resort.
 */
export function resolveHostWorkerPath(): string | undefined {
  const explicit = process.env.DUYA_HOST_WORKER_PATH;
  if (explicit !== undefined && explicit.trim().length > 0) return path.resolve(explicit.trim());

  for (const candidate of workerEntryCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Every place the worker entry may live, in priority order.
 *
 * Two layouts are covered:
 *
 * - Checkout: `packages/cli/{src,dist,bundle}` are all one directory below
 *   `packages/cli`, so `../../host/bundle/worker-entry.js` resolves to
 *   `packages/host/bundle/worker-entry.js` for all three.
 * - Packaged app: the CLI bundle is shipped as `resources/cli-bundle/cli.cjs`
 *   next to `resources/harness-bundle/worker-entry.js`.
 */
export function workerEntryCandidates(): string[] {
  const candidates: string[] = [];
  for (const dir of cliInstallDirs()) {
    candidates.push(path.resolve(dir, '..', '..', 'host', 'bundle', 'worker-entry.js'));
    candidates.push(path.resolve(dir, '..', 'harness-bundle', 'worker-entry.js'));
  }
  candidates.push(path.resolve(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js'));
  return candidates;
}

/** Directories that may hold this CLI's entry point. */
function cliInstallDirs(): string[] {
  const dirs: string[] = [];
  // The entry the user actually ran comes first: it is the installation this
  // process belongs to, and it is the one an embedding cannot change.
  const entry = process.argv[1];
  if (entry !== undefined && entry.length > 0) {
    dirs.push(path.dirname(path.resolve(entry)));
  }
  const moduleDir = moduleDirOfThisFile();
  if (moduleDir !== undefined && !dirs.includes(moduleDir)) dirs.push(moduleDir);
  return dirs;
}

/**
 * The directory holding this module.
 *
 * `import.meta.url` is a `file:` URL in the ESM build and in both CJS bundles
 * (they define it to `pathToFileURL(__filename).href`). It can still be an
 * `http:` URL in an Electron renderer, where `fileURLToPath` throws — hence
 * the guard rather than an assumption.
 */
function moduleDirOfThisFile(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}
