/**
 * Local whisper.cpp environment detection and provisioning guidance.
 *
 * This is the package's core responsibility per the user: manage the
 * machine's whisper environment and give first-use configuration guidance.
 * It detects the binary, reports platform-specific install commands, and
 * verifies the model file.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
  version?: string;
  /** Install commands (per platform) shown when the binary is missing. */
  installSteps: string[];
  /** Human-readable summary for the doctor command. */
  summary: string;
}

/** Whisper CLI binary name per platform. */
function binaryNames(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'win32':
      return ['whisper-cli.exe', 'whisper.exe'];
    case 'darwin':
      return ['whisper-cli', 'whisper'];
    default:
      return ['whisper-cli', 'whisper'];
  }
}

/** Common install locations for the whisper.cpp binary. */
function candidatePaths(platform: NodeJS.Platform): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const paths: string[] = [];
  switch (platform) {
    case 'win32': {
      // VCPKG / custom installs.
      paths.push(join(home, 'whisper.cpp', 'build', 'bin', 'whisper-cli.exe'));
      break;
    }
    case 'darwin': {
      // Homebrew installs whisper-cli into /usr/local or /opt/homebrew.
      paths.push('/opt/homebrew/bin/whisper-cli');
      paths.push('/usr/local/bin/whisper-cli');
      break;
    }
    default: {
      paths.push('/usr/local/bin/whisper-cli');
      paths.push('/usr/bin/whisper-cli');
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
        'Windows: download the whisper.cpp release ZIP from',
        '  https://github.com/ggerganov/whisper.cpp/releases',
        'Extract and place whisper-cli.exe into your PATH, or set the',
        'path explicitly in config.toml under [voice.stt.local].',
      ];
    case 'darwin':
      return [
        'macOS: install via Homebrew:',
        '  brew install whisper-cpp',
        '(or build from source: cmake -B build && cmake --build build -j)',
      ];
    default:
      return [
        'Linux: build from source:',
        '  cmake -B build && cmake --build build -j',
        'The binary is produced at build/bin/whisper-cli.',
      ];
  }
}

/** Detect whether a whisper.cpp binary is present on the current machine. */
export function detectWhisperBinary(
  platform: NodeJS.Platform = process.platform,
  explicitPath?: string,
): { found: boolean; path?: string } {
  if (explicitPath) {
    return { found: existsSync(explicitPath), path: explicitPath };
  }
  // Search PATH first (executables discoverable via `which`-like lookup).
  const names = binaryNames(platform);
  for (const name of names) {
    const fromPath = findOnPath(name);
    if (fromPath) return { found: true, path: fromPath };
  }
  for (const p of candidatePaths(platform)) {
    if (existsSync(p)) return { found: true, path: p };
  }
  return { found: false };
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

/** Build a full environment report for the `voice env doctor` command. */
export function collectEnvReport(explicitPath?: string): EnvReport {
  const platform = process.platform as Platform;
  const { found, path } = detectWhisperBinary(process.platform, explicitPath);
  const install = installSteps(process.platform);
  return {
    platform,
    binaryFound: found,
    binaryPath: path,
    installSteps: install,
    summary: found
      ? `whisper.cpp binary found at ${path}`
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