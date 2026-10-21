/**
 * Shell detector - detects the best available shell for the current platform
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ShellInfo {
  /** Shell name for display */
  name: string;
  /** Full path to the shell executable */
  path: string;
  /** Shell family: 'unix', 'powershell', 'cmd' */
  family: 'unix' | 'powershell' | 'cmd';
  /** Whether the shell supports Unix-style commands (ls, cat, etc.) */
  supportsUnixCommands: boolean;
  /** Shell argument to execute a command string */
  execArg: string;
}

export type ShellFamilyPreference = ShellInfo['family'] | 'auto';

const COMMON_UNIX_SHELLS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\ProgramData\\chocolatey\\bin\\bash.exe',
  'C:\\msys64\\usr\\bin\\bash.exe',
  'C:\\cygwin64\\bin\\bash.exe',
  'C:\\cygwin\\bin\\bash.exe',
];

const COMMON_PWSH_PATHS = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
];

function findInPath(executable: string): string | null {
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    const fullPath = path.join(dir, executable);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
    // Also try with .exe on Windows
    if (process.platform === 'win32') {
      const withExe = fullPath + '.exe';
      if (fs.existsSync(withExe)) {
        return withExe;
      }
    }
  }
  return null;
}

function tryShell(shellPath: string): boolean {
  try {
    return fs.existsSync(shellPath);
  } catch {
    return false;
  }
}

/**
 * Detect the best available shell on Windows
 * Priority: Git Bash > PowerShell 7 > PowerShell 5 > CMD
 */
function detectWindowsShell(): ShellInfo {
  // 1. Try Git Bash / MSYS2 / Cygwin
  for (const shellPath of COMMON_UNIX_SHELLS) {
    if (tryShell(shellPath)) {
      return {
        name: 'bash (Git Bash)',
        path: shellPath,
        family: 'unix',
        supportsUnixCommands: true,
        execArg: '-c',
      };
    }
  }

  // Try to find bash in PATH
  const bashInPath = findInPath('bash');
  if (bashInPath) {
    return {
      name: 'bash',
      path: bashInPath,
      family: 'unix',
      supportsUnixCommands: true,
      execArg: '-c',
    };
  }

  // 2. Try PowerShell 7 (pwsh)
  for (const pwshPath of COMMON_PWSH_PATHS) {
    if (tryShell(pwshPath)) {
      return {
        name: 'pwsh (PowerShell 7)',
        path: pwshPath,
        family: 'powershell',
        supportsUnixCommands: false,
        execArg: '-Command',
      };
    }
  }

  const pwshInPath = findInPath('pwsh');
  if (pwshInPath) {
    return {
      name: 'pwsh (PowerShell 7)',
      path: pwshInPath,
      family: 'powershell',
      supportsUnixCommands: false,
      execArg: '-Command',
    };
  }

  // 3. Try PowerShell 5 (Windows PowerShell)
  const psInPath = findInPath('powershell');
  if (psInPath) {
    return {
      name: 'powershell (Windows PowerShell)',
      path: psInPath,
      family: 'powershell',
      supportsUnixCommands: false,
      execArg: '-Command',
    };
  }

  // 4. Fallback to CMD
  const cmdPath = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  return {
    name: 'cmd',
    path: cmdPath,
    family: 'cmd',
    supportsUnixCommands: false,
    execArg: '/c',
  };
}

function detectWindowsShellForFamily(family: Exclude<ShellFamilyPreference, 'auto'>): ShellInfo | null {
  if (family === 'unix') {
    for (const shellPath of COMMON_UNIX_SHELLS) {
      if (tryShell(shellPath)) {
        return {
          name: 'bash (Git Bash)',
          path: shellPath,
          family: 'unix',
          supportsUnixCommands: true,
          execArg: '-c',
        };
      }
    }

    const bashInPath = findInPath('bash');
    if (bashInPath) {
      return {
        name: 'bash',
        path: bashInPath,
        family: 'unix',
        supportsUnixCommands: true,
        execArg: '-c',
      };
    }

    return null;
  }

  if (family === 'powershell') {
    for (const pwshPath of COMMON_PWSH_PATHS) {
      if (tryShell(pwshPath)) {
        return {
          name: 'pwsh (PowerShell 7)',
          path: pwshPath,
          family: 'powershell',
          supportsUnixCommands: false,
          execArg: '-Command',
        };
      }
    }

    const pwshInPath = findInPath('pwsh');
    if (pwshInPath) {
      return {
        name: 'pwsh (PowerShell 7)',
        path: pwshInPath,
        family: 'powershell',
        supportsUnixCommands: false,
        execArg: '-Command',
      };
    }

    const psInPath = findInPath('powershell');
    if (psInPath) {
      return {
        name: 'powershell (Windows PowerShell)',
        path: psInPath,
        family: 'powershell',
        supportsUnixCommands: false,
        execArg: '-Command',
      };
    }

    return null;
  }

  const cmdPath = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  return {
    name: 'cmd',
    path: cmdPath,
    family: 'cmd',
    supportsUnixCommands: false,
    execArg: '/c',
  };
}

/**
 * Detect the best available shell on Unix-like systems
 */
function detectUnixShell(): ShellInfo {
  const shellFromEnv = process.env.SHELL;
  if (shellFromEnv && tryShell(shellFromEnv)) {
    const name = path.basename(shellFromEnv);
    return {
      name,
      path: shellFromEnv,
      family: 'unix',
      supportsUnixCommands: true,
      execArg: '-c',
    };
  }

  // Fallbacks
  const fallbacks = ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'];
  for (const shellPath of fallbacks) {
    if (tryShell(shellPath)) {
      const name = path.basename(shellPath);
      return {
        name,
        path: shellPath,
        family: 'unix',
        supportsUnixCommands: true,
        execArg: '-c',
      };
    }
  }

  // Ultimate fallback
  return {
    name: 'sh',
    path: '/bin/sh',
    family: 'unix',
    supportsUnixCommands: true,
    execArg: '-c',
  };
}

function detectUnixShellForFamily(family: Exclude<ShellFamilyPreference, 'auto'>): ShellInfo | null {
  if (family === 'unix') {
    // When the caller asks for the 'unix' family (e.g. the bash shell
    // provider), prefer an actual bash binary over the user's login shell.
    // On macOS the default $SHELL is zsh, but the agent's prompts and
    // quoting assume bash semantics (arrays, $0, glob). Looking up bash
    // first avoids silently running zsh under a "bash" label, which causes
    // subtle script incompatibilities. Falls back to the login shell and
    // then to /bin/sh if no bash is available.
    const bashCandidates = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'];
    for (const candidate of bashCandidates) {
      if (tryShell(candidate)) {
        return {
          name: 'bash',
          path: candidate,
          family: 'unix',
          supportsUnixCommands: true,
          execArg: '-c',
        };
      }
    }
    const bashInPath = findInPath('bash');
    if (bashInPath) {
      return {
        name: 'bash',
        path: bashInPath,
        family: 'unix',
        supportsUnixCommands: true,
        execArg: '-c',
      };
    }
    // No bash available — fall back to the user's shell / sh.
    return detectUnixShell();
  }

  if (family === 'powershell') {
    const pwshInPath = findInPath('pwsh');
    if (!pwshInPath) return null;
    return {
      name: 'pwsh (PowerShell 7)',
      path: pwshInPath,
      family: 'powershell',
      supportsUnixCommands: false,
      execArg: '-Command',
    };
  }

  return null;
}

let cachedShellInfo: ShellInfo | null = null;

/**
 * Detect the best available shell for the current platform.
 * Results are cached after first call.
 */
export function detectShell(): ShellInfo {
  if (cachedShellInfo) {
    return cachedShellInfo;
  }

  if (process.platform === 'win32') {
    cachedShellInfo = detectWindowsShell();
  } else {
    cachedShellInfo = detectUnixShell();
  }

  return cachedShellInfo;
}

export function detectShellForFamily(
  family: ShellFamilyPreference,
): ShellInfo | null {
  if (family === 'auto') {
    return detectShell();
  }

  if (process.platform === 'win32') {
    return detectWindowsShellForFamily(family);
  }

  return detectUnixShellForFamily(family);
}

/**
 * Get shell info for prompt display
 */
export function getShellForPrompt(): string {
  const shell = detectShell();
  return shell.name;
}

/**
 * Check if the current platform has a Unix-compatible shell available
 * (Git Bash, WSL, MSYS2, Cygwin, or native Unix shell)
 */
export function hasUnixCompatibleShell(): boolean {
  return detectShell().supportsUnixCommands;
}

export function hasShellFamily(
  family: Exclude<ShellFamilyPreference, 'auto'>,
): boolean {
  return detectShellForFamily(family) !== null;
}

/**
 * Get the shell execution configuration for spawning processes
 */
export function getShellExecConfig(): { shell: string; shellArg: string } {
  const shell = detectShell();
  return {
    shell: shell.path,
    shellArg: shell.execArg,
  };
}

/**
 * Clear the shell detection cache (useful for testing)
 */
export function clearShellCache(): void {
  cachedShellInfo = null;
}
