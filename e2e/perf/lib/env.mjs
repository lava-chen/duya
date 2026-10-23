/**
 * e2e/perf/lib/env.mjs — the environment every report has to carry.
 *
 * A performance number without its environment is not comparable with
 * anything, so the report always states the machine, the build and the
 * versions the numbers were produced with.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './launch.mjs';

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Machine facts that do not need the app to be running. */
export function captureHostEnvironment() {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    osPlatform: os.platform(),
    osArch: os.arch(),
    cpuModel: cpus.length > 0 ? cpus[0].model.trim() : 'unknown',
    cpuCount: cpus.length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
    nodeVersion: process.version,
    hostname: os.hostname(),
  };
}

/** The checkout the numbers were produced from. */
export function captureRepositoryState() {
  const status = git(['status', '--porcelain']);
  return {
    repoRoot: REPO_ROOT,
    gitSha: git(['rev-parse', 'HEAD']),
    gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitDirty: status === null ? null : status.length > 0,
    gitDirtyPaths: status === null || status.length === 0 ? [] : status.split('\n').slice(0, 20),
  };
}

/**
 * The app-level facts: the Electron / Chromium versions the renderer ran in,
 * the GPU feature status and the renderer URL that was loaded.
 */
export async function captureAppEnvironment(app) {
  let versions = null;
  try {
    versions = await app.evaluate(({ app: electronApp }) => ({
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node ?? null,
      v8: process.versions.v8 ?? null,
      platform: process.platform,
      packaged: electronApp.isPackaged,
    }));
  } catch {
    versions = null;
  }
  let gpu = null;
  try {
    gpu = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus());
  } catch {
    gpu = null;
  }
  return { versions, gpu };
}
