/**
 * packages/agent/tests/cli-control-plane/harness.ts
 *
 * Spawns a real Electron main process running the actual duya GUI
 * (with the CLI API server up), pointing at an isolated temporary
 * userData directory, and waits for the runtime discovery file.
 *
 * All session rows used by the regression test are seeded into a
 * fresh test DB inside the same temp userData before the harness
 * returns. After teardown, the temp directory is removed.
 *
 * IMPORTANT: never import this from production code. The harness
 * only uses real CLI entry points, real server code, and a temp
 * userData — but it does launch the real Electron app, which will
 * create a (headless or background) BrowserWindow. This is the
 * strongest possible integration test we can run without a packaged
 * build.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..', '..', '..', '..');

// Use process.execPath (the Node binary) as the SPAWN target and pass
// the entry script directly. We do not use npx here because vitest
// workers may not have npx on PATH, depending on how the test runner
// was launched.
const NODE_BIN = process.execPath;
const ELECTRON_BIN = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
function runNode(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: any } = {}) {
  return spawn(NODE_BIN, args, {
    cwd: opts.cwd ?? projectRoot,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

export interface Harness {
  userData: string;
  runtimeFile: string;
  token: string;
  port: number;
  pid: number;
  electronProc: ChildProcess;
  /** Stop the Electron process and remove the temp userData. */
  teardown(): Promise<void>;
}

/**
 * Seed a fresh test DB at userData/databases/duya-main.db with the
 * minimum schema needed by listSessionSummaries / getSessionSummary,
 * then insert the given rows.
 */
async function seedTestDatabase(userData: string, sessions: SeedSession[]): Promise<void> {
  const dbDir = join(userData, 'databases');
  await mkdir(dbDir, { recursive: true });
  const seedScript = join(__dirname, 'seed-db.cjs');
  // Write the payload to a sibling file so the Electron child picks
  // it up via an env var; this avoids the stdin-pipe gotcha where
  // Electron's main process swallows piped stdin in some configurations.
  const payloadFile = join(userData, '.seed-payload.json');
  await writeFile(payloadFile, JSON.stringify({ userData, sessions }), 'utf-8');

  // Capture stdout/stderr via async spawn with file redirection so
  // we always have a deterministic exit status (spawnSync on a
  // detached child can return status=null).
  const outFile = join(userData, '.seed-stdout.log');
  const errFile = join(userData, '.seed-stderr.log');
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(outFile, '', 'utf-8').catch(() => null);
  await wf(errFile, '', 'utf-8').catch(() => null);
  const stdoutFd = await import('node:fs').then((m) => m.openSync(outFile, 'w'));
  const stderrFd = await import('node:fs').then((m) => m.openSync(errFile, 'w'));

  await new Promise<void>((resolve, reject) => {
    // Spawn electron directly (not ELECTRON_RUN_AS_NODE) so the seed
    // script gets the real `app` API. The script exits via app.exit(0)
    // when seeding completes.
    const child = spawn(
      ELECTRON_BIN,
      [seedScript],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLI_SEED_PAYLOAD_FILE: payloadFile,
        },
        stdio: ['ignore', stdoutFd, stderrFd],
      },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      const { readFileSync: rfs } = require('node:fs');
      const stdout = (() => { try { return rfs(outFile, 'utf-8'); } catch { return ''; } })();
      const stderr = (() => { try { return rfs(errFile, 'utf-8'); } catch { return ''; } })();
      if (code !== 0) {
        reject(new Error(`seed-db script failed (exit=${code}):\nstdout: ${stdout}\nstderr: ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

export interface SeedSession {
  id: string;
  title?: string;
  mode?: 'code' | 'plan' | 'ask' | 'automation';
  parent_id?: string | null;
  agent_type?: 'main' | 'sub-agent';
  is_deleted?: 0 | 1;
  /** If true, the id will be prefixed gw- */
  gateway?: boolean;
  model?: string;
  /** Number of messages to seed for this session. */
  messageCount?: number;
}

/**
 * Start a real Electron main process with the CLI API server up,
 * pointing at an isolated temp userData with a seeded test DB.
 *
 * Returns a Harness that exposes the connection info needed to drive
 * the CLI client.
 */
export async function startHarness(sessions: SeedSession[]): Promise<Harness> {
  const userData = await mkdtemp(join(tmpdir(), 'duya-cli-test-'));
  await seedTestDatabase(userData, sessions);

  const envOverride = `DUYA_CLI_USER_DATA_DIR=${userData}`;
  // The headless server writes its own runtime file inside the
  // temp userData; clear any stale file in case a prior test used
  // the same path.
  const runtimeFile = join(userData, 'runtime', 'cli-api.json');
  try {
    await import('node:fs/promises').then((m) => m.unlink(runtimeFile).catch(() => null));
  } catch {
    // ignore
  }

  // Spawn the headless Electron entry that boots ONLY the CLI API
  // server (no renderer, no GUI). This avoids the vite + dev-mode
  // complications of `electron .` while still using the real server
  // source compiled by esbuild.
  const headlessEntry = join(__dirname, 'headless-server.cjs');
  const electronProc = spawn(
    ELECTRON_BIN,
    [headlessEntry],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        CLI_TEST_USER_DATA: userData,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // The CLI API server writes to <userData>/runtime/cli-api.json
  // approximately 1-2 seconds after app.whenReady. We poll for the
  // file (declared above) until the deadline.
  const deadline = Date.now() + 30_000;
  let runtime: { port: number; token: string; pid: number } | null = null;
  while (Date.now() < deadline) {
    if (existsSync(runtimeFile)) {
      try {
        runtime = JSON.parse(await readFile(runtimeFile, 'utf-8'));
        break;
      } catch {
        // partial write
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!runtime) {
    electronProc.kill();
    throw new Error('Harness timeout: CLI API server did not write runtime file within 30s');
  }

  const env = `${envOverride}`;
  return {
    userData,
    runtimeFile,
    token: runtime.token,
    port: runtime.port,
    pid: runtime.pid,
    electronProc,
    async teardown() {
      try {
        electronProc.kill();
      } catch {
        // ignore
      }
      // Best-effort cleanup
      try {
        await rm(userData, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Invoke the real CLI entrypoint against the harness. The CLI is
 * resolved from the project root: `npx tsx packages/agent/src/cli/index.ts`.
 * This is the SAME code path the user runs in production — only the
 * transport target (the runtime file) is temp.
 */
export function runCli(
  env: string,
  args: string[],
  cwd = projectRoot,
): { status: number; stdout: string; stderr: string } {
  // Use the pre-built CLI bundle (packages/agent/bundle/cli.cjs)
  // instead of tsx, so the test runner doesn't need tsx on PATH.
  const cliBundle = join(projectRoot, 'packages', 'agent', 'bundle', 'cli.cjs');
  const result = spawnSync(
    NODE_BIN,
    [cliBundle, ...args],
    {
      cwd,
      env: { ...process.env, ...parseEnv(env) },
      encoding: 'utf-8',
      timeout: 30_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export interface DoctorResult {
  version: string;
  timestamp: number;
  overallStatus: 'ok' | 'warning' | 'error';
  profile: 'production' | 'development' | 'unknown';
  checks: Array<{
    id: string;
    category: string;
    status: 'ok' | 'warning' | 'error' | 'skipped';
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
  }>;
  summary: {
    errors: number;
    warnings: number;
    skipped: number;
    ok: number;
  };
}

/**
 * Run `duya doctor` against the harness.
 */
export function runDoctor(
  env: string,
  format: 'text' | 'json' = 'text',
): { status: number; stdout: string; stderr: string; json?: DoctorResult } {
  const cliBundle = join(projectRoot, 'packages', 'agent', 'bundle', 'cli.cjs');
  const args = ['doctor'];
  if (format === 'json') args.push('--format', 'json');
  const result = spawnSync(NODE_BIN, [cliBundle, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...parseEnv(env) },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json: format === 'json' ? safeParseJson(result.stdout ?? '') : undefined,
  };
}

function safeParseJson(s: string): DoctorResult | undefined {
  try {
    return JSON.parse(s) as DoctorResult;
  } catch {
    return undefined;
  }
}
