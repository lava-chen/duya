/**
 * Local whisper.cpp environment detection and provisioning guidance.
 *
 * Resolution order: explicit `binary_path` config → managed runtime dir
 * (`~/.duya/voice/bin`, installed by RuntimeManager) → PATH → common
 * install locations. Reports platform-specific install guidance and whether
 * one-click install is available.
 */
import { existsSync, statSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import {
  runtimeAssetForPlatform,
  WHISPER_BINARY_NAMES,
  DEFAULT_RUNTIME_BASE,
} from './runtime-manager';
import type { ModelStatusDTO } from './types';

export type Platform = 'win32' | 'darwin' | 'linux';

/**
 * Smallest plausible ggml model file. Below this a model file is a
 * truncated download rather than a model.
 *
 * The suite has imported this by name since the truncation check was
 * written; when the check was dropped the export went with it and the
 * import silently degraded to `undefined` instead of failing, which is
 * what turned a missing guard into `Buffer.alloc(undefined)` in the test.
 */
export const MIN_MODEL_BYTES = 1024 * 1024;

export interface WhisperBinaryGuess {
  /** Candidate paths where a `whisper-cli` / `whisper.cpp` binary may live. */
  candidates: string[];
  /** Install guidance for the current platform. */
  install: string[];
}

export interface EnvReport {
  platform: Platform;
  binaryFound: boolean;
  binaryPath?: string;
  /** Source of the detected binary (config / managed / path / candidates). */
  binarySource?: 'config' | 'managed' | 'path' | 'candidate';
  /** One-click runtime install is supported on this platform. */
  runtimeInstallable: boolean;
  /** Download base used by RuntimeManager (mirror-aware). */
  runtimeBaseUrl: string;
  version?: string;
  /** Install commands (per platform) shown when the binary is missing. */
  installSteps: string[];
  /** Human-readable summary for the doctor command. */
  summary: string;
}

/** Common install locations for the whisper.cpp binary. */
function candidatePaths(platform: NodeJS.Platform): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || '';
  const programData = process.env.PROGRAMDATA || '';
  const paths: string[] = [];
  switch (platform) {
    case 'win32': {
      // whisper.cpp built from source (classic + modern layouts).
      for (const bin of ['whisper-cli.exe', 'main.exe']) {
        paths.push(join(home, 'whisper.cpp', 'build', 'bin', bin));
        paths.push(join(home, 'whisper.cpp', 'bin', bin));
      }
      paths.push(join(local, 'Programs', 'whisper.cpp', 'whisper-cli.exe'));
      paths.push(join(home, 'scoop', 'shims', 'whisper-cli.exe'));
      paths.push(join(programData, 'chocolatey', 'bin', 'whisper-cli.exe'));
      break;
    }
    case 'darwin': {
      paths.push('/opt/homebrew/bin/whisper-cli');
      paths.push('/usr/local/bin/whisper-cli');
      break;
    }
    default: {
      paths.push('/usr/local/bin/whisper-cli');
      paths.push('/usr/bin/whisper-cli');
      paths.push(join(home, '.local', 'bin', 'whisper-cli'));
      break;
    }
  }
  return paths;
}

/** Platform-specific install guidance. */
function installSteps(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'win32':
      return [
        'Windows: 在 设置 → 语音输入 点击「一键安装」自动下载 whisper.cpp，或',
        '从 https://github.com/ggml-org/whisper.cpp/releases 下载 whisper-bin-x64.zip',
        '解压后在设置中配置二进制路径（[voice.stt.local] binary_path）。',
      ];
    case 'darwin':
      return [
        'macOS: install via Homebrew:',
        '  brew install whisper-cpp',
        '(or build from source: cmake -B build && cmake --build build -j)',
      ];
    default:
      return [
        'Linux: 在 设置 → 语音输入 点击「一键安装」，或',
        'build from source: cmake -B build && cmake --build build -j',
        'The binary is produced at build/bin/whisper-cli.',
      ];
  }
}

export interface DetectWhisperOptions {
  /** Explicit `voice.stt.local.binary_path` config value. */
  explicitPath?: string;
  /** Managed runtime dir (`~/.duya/voice/bin`), checked before PATH. */
  managedBinDir?: string;
}

/**
 * Binary names to accept when searching PATH.
 *
 * PATH is the one place where the name alone is not evidence. `pip install
 * openai-whisper` puts a console script called `whisper` (or `whisper.exe`)
 * there, and it is a completely different program from the whisper.cpp CLI.
 * Matching it made the doctor report "whisper.cpp binary found at ..." and
 * handed the local STT engine a Python entry point, which then failed at
 * run time with an error that pointed nowhere near the real cause.
 *
 * The ambiguous names stay valid for the managed dir and the common install
 * locations, which are whisper.cpp-specific directories rather than whatever
 * else the machine happens to have installed.
 */
const PATH_SAFE_BINARY_NAMES = ['whisper-cli', 'whisper-cli.exe', 'whisper-cpp', 'whisper-cpp.exe'];

/**
 * Detect whether a whisper.cpp CLI binary is present on this machine.
 * Order: explicit config → managed dir → PATH → common candidates.
 */
export function detectWhisperBinary(
  platform: NodeJS.Platform = process.platform,
  explicitPath?: string,
  managedBinDir?: string,
): { found: boolean; path?: string; source?: 'config' | 'managed' | 'path' | 'candidate' } {
  if (explicitPath && explicitPath.trim()) {
    const p = explicitPath.trim();
    return { found: existsSync(p), path: p, source: 'config' };
  }
  if (managedBinDir) {
    for (const name of WHISPER_BINARY_NAMES) {
      const p = join(managedBinDir, name);
      if (isFile(p)) return { found: true, path: p, source: 'managed' };
    }
  }
  // Search PATH first (executables discoverable via `which`-like lookup).
  // Only the unambiguous whisper.cpp names qualify here -- see
  // PATH_SAFE_BINARY_NAMES.
  for (const name of PATH_SAFE_BINARY_NAMES) {
    const fromPath = findOnPath(name, platform);
    if (fromPath) return { found: true, path: fromPath, source: 'path' };
  }
  for (const p of candidatePaths(platform)) {
    if (isFile(p)) return { found: true, path: p, source: 'candidate' };
  }
  return { found: false };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Minimal PATH lookup (respects PATHEXT on Windows).
 *
 * The entry separator comes from the target `platform`, not from the host.
 * PATH is ';'-joined on Windows and ':'-joined everywhere else, so splitting
 * on a hardcoded ';' yields one garbage entry on Linux/macOS and the lookup
 * can never succeed there. Deriving it from the host instead (`path.delimiter`)
 * would fix the dead lookup but still answer for the host rather than for the
 * platform the caller asked about, so the platform is threaded through.
 */
function findOnPath(bin: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const pathEnv = process.env.PATH || '';
  const exts = platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(win32.delimiter)
    : [''];
  for (const dir of pathEnv.split(platform === 'win32' ? win32.delimiter : posix.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, bin.toLowerCase().endsWith(ext.toLowerCase()) ? bin : bin + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

export interface CollectEnvOptions extends DetectWhisperOptions {
  /** Mirror / custom release-download base used by RuntimeManager. */
  runtimeBaseUrl?: string;
}

/** Build a full environment report for the `voice env doctor` command. */
export function collectEnvReport(opts?: CollectEnvOptions): EnvReport {
  const platform = process.platform as Platform;
  const baseUrl = opts?.runtimeBaseUrl?.trim() || DEFAULT_RUNTIME_BASE;
  const { found, path, source } = detectWhisperBinary(
    process.platform,
    opts?.explicitPath,
    opts?.managedBinDir,
  );
  const install = installSteps(process.platform);
  const runtimeInstallable = runtimeAssetForPlatform(process.platform, process.arch, baseUrl) !== null;
  return {
    platform,
    binaryFound: found,
    binaryPath: path,
    binarySource: source,
    runtimeInstallable,
    runtimeBaseUrl: baseUrl,
    installSteps: install,
    summary: found
      ? `whisper.cpp binary found at ${path}`
      : runtimeInstallable
        ? 'whisper.cpp binary is missing. 可在设置中一键安装。'
        : 'whisper.cpp binary is missing. Follow the install steps below.',
  };
}

/** Verify a model file exists and report its size. */
export function checkModel(modelPath: string): ModelStatusDTO {
  const base = modelPath.split(/[\\/]/).pop() || modelPath;
  if (!existsSync(modelPath)) {
    return { model: base, ready: false, sizeMb: 0, path: modelPath };
  }
  const stat = statSync(modelPath);
  // A download that was interrupted leaves a plausible-looking file behind.
  // Reporting that as ready sends the local STT engine off to load a
  // truncated ggml file, which fails with a parse error that says nothing
  // about the actual cause. The smallest shipped ggml base model is well
  // over 1 MB, so anything under that is a leftover, not a model.
  if (stat.size < MIN_MODEL_BYTES) {
    return { model: base, ready: false, sizeMb: 0, path: modelPath };
  }
  return { model: base, ready: true, sizeMb: Math.round(stat.size / 1024 / 1024), path: modelPath };
}
