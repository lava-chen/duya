/**
 * ipc/ide-handlers.ts - External IDE detection and "open in IDE" IPC.
 *
 * Detects IDEs installed on the host (VSCode / Cursor / TRAE / Zed) so the
 * file preview "Open" action can launch the file in a real editor instead of
 * the OS default app. Detection is layered: common install directories first,
 * then PATH CLI lookup (`where` / `which`). All resolution is pure and
 * testable; the IPC layer only wires it to the renderer.
 */

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { getConfigStore } from '../config/store-instance';

const execFileAsync = promisify(execFile);

export type IdeId = 'vscode' | 'cursor' | 'trae' | 'zed';

export interface IdeInfo {
  id: IdeId;
  name: string;
  /** Executable path resolved at detection time (or empty when not found). */
  executable: string;
  /** OS shell icon extracted from the executable (PNG data URL), when the
   *  platform can provide one. The renderer falls back to its built-in
   *  brand mark when absent. */
  icon?: string;
}

interface IdeDef {
  id: IdeId;
  name: string;
  /** CLI command used to look up the IDE on PATH. */
  cli: string;
  /** Candidate absolute executable paths, checked in order. */
  candidates: string[];
}

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? '';
}

/** Build the candidate executable paths for each IDE for the current platform. */
export function buildIdeCandidates(platform = process.platform): Record<IdeId, string[]> {
  const la = localAppData();
  const programs = path.join(la, 'Programs');

  if (platform === 'win32') {
    return {
      vscode: [
        path.join(programs, 'Microsoft VS Code', 'Code.exe'),
        path.join(la, 'Microsoft VS Code', 'Code.exe'),
      ],
      cursor: [
        path.join(programs, 'cursor', 'Cursor.exe'),
        path.join(la, 'Programs', 'Cursor', 'Cursor.exe'),
      ],
      trae: [
        path.join(programs, 'Trae', 'Trae.exe'),
        path.join(la, 'Trae', 'Trae.exe'),
        path.join(la, 'Programs', 'Trae CN', 'Trae CN.exe'),
      ],
      zed: [
        path.join(la, 'Programs', 'Zed', 'zed.exe'),
        path.join(programs, 'Zed', 'zed.exe'),
      ],
    };
  }

  if (platform === 'darwin') {
    return {
      vscode: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
      cursor: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
      trae: ['/Applications/Trae.app/Contents/MacOS/Trae'],
      zed: ['/Applications/Zed.app/Contents/MacOS/zed'],
    };
  }

  // Linux
  return {
    vscode: ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'],
    cursor: ['/usr/bin/cursor', '/usr/local/bin/cursor'],
    trae: ['/usr/bin/trae', '/opt/trae/trae'],
    zed: ['/usr/bin/zed', '/usr/local/bin/zed'],
  };
}

const IDE_DEFS: Array<Omit<IdeDef, 'candidates'>> = [
  { id: 'vscode', name: 'Visual Studio Code', cli: 'code' },
  { id: 'cursor', name: 'Cursor', cli: 'cursor' },
  { id: 'trae', name: 'TRAE', cli: 'trae' },
  { id: 'zed', name: 'Zed', cli: 'zed' },
];

/** Look up a CLI binary on PATH via `where` (Windows) / `which` (Unix). */
export async function findExecutableOnPath(cli: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, [cli], { timeout: 3000 });
    const line = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** Resolve the executable for a single IDE; null when not installed. */
export async function resolveIdeExecutable(
  id: IdeId,
  platform = process.platform,
): Promise<string | null> {
  const candidates = buildIdeCandidates(platform)[id];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore probe errors
    }
  }
  const def = IDE_DEFS.find((d) => d.id === id);
  if (!def) return null;
  return findExecutableOnPath(def.cli);
}

/** Detect all installed IDEs, ordered by the canonical IDE_DEFS order. */
export async function detectInstalledIdes(platform = process.platform): Promise<IdeInfo[]> {
  const out: IdeInfo[] = [];
  for (const def of IDE_DEFS) {
    const executable = await resolveIdeExecutable(def.id, platform);
    if (executable) {
      out.push({ id: def.id, name: def.name, executable });
    }
  }
  // Attach the OS shell icon per IDE; extraction failures simply leave the
  // field undefined so the renderer falls back to its brand mark.
  return Promise.all(
    out.map(async (ide) => ({ ...ide, icon: await extractIdeIcon(ide.executable) })),
  );
}

/**
 * Icon source for shell-icon extraction: on macOS the `.app` bundle (CLI
 * shims like `.../bin/code` carry no icon), elsewhere the executable itself.
 */
export function resolveIconTarget(executable: string, platform = process.platform): string {
  if (platform !== 'darwin') return executable;
  // Split on both separators so the resolution stays testable on Windows CI.
  const segments = executable.split(/[/\\]/);
  const bundleEnd = segments.findIndex((segment) => segment.endsWith('.app'));
  return bundleEnd >= 0 ? segments.slice(0, bundleEnd + 1).join('/') : executable;
}

/**
 * Whether shell-icon extraction can yield a meaningful icon. Windows CLI
 * shims (`code.cmd`) would render a generic script icon, so only real `.exe`
 * targets qualify; on Linux ELF launchers are tried as-is.
 */
export function canExtractIcon(executable: string, platform = process.platform): boolean {
  if (platform === 'win32') return /\.exe$/i.test(executable);
  if (platform === 'darwin') return resolveIconTarget(executable, platform).endsWith('.app');
  return true;
}

/** Extract the OS shell icon for an IDE executable as a PNG data URL —
 *  the same source the OS "Open with" menus render. */
async function extractIdeIcon(executable: string): Promise<string | undefined> {
  if (!canExtractIcon(executable)) return undefined;
  try {
    // Dynamic import keeps the module loadable outside Electron (unit tests).
    const { app } = await import('electron');
    const image = await app.getFileIcon(resolveIconTarget(executable), { size: 'large' });
    return image.toDataURL();
  } catch {
    return undefined;
  }
}

/** Resolve the effective default IDE: config `ide.default` if detected, else
 *  the first detected IDE, else null. */
export async function resolveDefaultIde(
  detected: IdeInfo[],
  configuredDefault?: string,
): Promise<IdeInfo | null> {
  if (configuredDefault) {
    const match = detected.find((ide) => ide.id === configuredDefault);
    if (match) return match;
  }
  return detected[0] ?? null;
}

/** Validate the renderer-supplied target path for IDE launch. */
function validateTarget(target: string): string | null {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096) return null;
  if (target.includes('\0')) return null;
  return target;
}

/** Launch a target path (file or folder) in the given IDE. */
export async function openInIde(id: IdeId, target: string): Promise<string> {
  if (!IDE_DEFS.some((d) => d.id === id)) return `Unknown IDE: ${id}`;
  const safeTarget = validateTarget(target);
  if (!safeTarget) return 'Invalid path';
  const executable = await resolveIdeExecutable(id);
  if (!executable) return `${id} not installed`;
  try {
    await execFileAsync(executable, [safeTarget]);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function registerIdeHandlers(): void {
  // List installed IDEs (executables resolved at call time).
  ipcMain.handle('ide:list', async () => detectInstalledIdes());

  // Resolve the effective default IDE given the configured `ide.default`.
  ipcMain.handle('ide:get-default', async () => {
    const detected = await detectInstalledIdes();
    const configured = (getConfigStore().getByPath('ide.default') as string | undefined) ?? '';
    return resolveDefaultIde(detected, configured);
  });

  // Open a file/folder in the given IDE.
  ipcMain.handle('ide:open', async (_event, id: string, target: string) => {
    return openInIde(id as IdeId, target);
  });
}