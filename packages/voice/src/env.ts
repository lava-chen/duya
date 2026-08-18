/**
 * Local whisper.cpp environment detection and provisioning guidance.
 *
 * Resolution order: explicit `binary_path` config → managed runtime dir
 * (`~/.duya/voice/bin`, installed by RuntimeManager) → PATH → common
 * install locations. Reports platform-specific install guidance and whether
 * one-click install is available.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  runtimeAssetForPlatform,
  WHISPER_BINARY_NAMES,
  DEFAULT_RUNTIME_BASE,
} from './runtime-manager';
import type { ModelStatusDTO } from './types';

export type Platform = 'win32' | 'darwin' | 'linux';

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

/** Whisper CLI binary names per platform, preference-ordered. */
function binaryNames(platform: NodeJS.Platform): string[] {
  const base = ['whisper-cli', 'whisper'];
  if (platform === 'win32') {
    return ['whisper-cli.exe', 'whisper.exe', 'main.exe'];
  }
  return base;
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
  const names = binaryNames(platform);
  for (const name of names) {
    const fromPath = findOnPath(name);
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

/** Minimal PATH lookup (respects PATHEXT on Windows). */
function findOnPath(bin: string): string | undefined {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of pathEnv.split(';')) {
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
  return { model: base, ready: true, sizeMb: Math.round(stat.size / 1024 / 1024), path: modelPath };
}
