/**
 * ipc/references-handlers.ts - Project references IPC handlers
 *
 * Manages the per-project `.duya/references/` directory: list, add (copy),
 * delete, and open files. All paths are validated to stay inside the
 * `<workingDirectory>/.duya/references/` root to prevent path traversal.
 *
 * No DB persistence — state lives entirely on the filesystem.
 */

import { ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger, LogComponent } from '../logging/logger';
import { getMainWindow } from '../core/window-manager';

/**
 * One entry in the references directory listing.
 */
export interface ReferenceEntry {
  /** Base name (e.g. `api-spec.md`). */
  name: string;
  /** Path relative to `.duya/references/` (POSIX separators). */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** File size in bytes. `0` for directories. */
  size: number;
  /** Whether this entry is a directory. */
  isDirectory: boolean;
  /** Last-modified time in ms epoch. */
  mtime: number;
  /** Lowercased extension without the dot (e.g. `md`, `pdf`). `''` for dirs / no extension. */
  extension?: string;
}

/** Result shape for list/add/delete operations. */
interface ReferencesResult<T = undefined> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Resolve and validate that `relativePath` stays inside the references root. */
function resolveInsideReferences(
  workingDirectory: string,
  relativePath: string,
): { ok: true; absolute: string } | { ok: false; error: string } {
  if (!workingDirectory || typeof workingDirectory !== 'string') {
    return { ok: false, error: 'Invalid working directory' };
  }
  if (!relativePath || typeof relativePath !== 'string') {
    return { ok: false, error: 'Invalid relative path' };
  }
  // Reject absolute paths and null bytes outright.
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    return { ok: false, error: 'Path traversal denied' };
  }
  const root = path.join(workingDirectory, '.duya', 'references');
  const resolved = path.resolve(root, relativePath);
  // `path.relative` from root must not start with `..` and must not be absolute.
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '.' ) {
    // Points at the root itself — allowed for list, but not for delete/open.
    return { ok: true, absolute: resolved };
  }
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    return { ok: false, error: 'Path traversal denied' };
  }
  return { ok: true, absolute: resolved };
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Recursively walk `dir` and collect ReferenceEntry for all contents. */
function walkReferences(dir: string, root: string, out: ReferenceEntry[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    const relativePath = toPosix(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        relativePath,
        absolutePath: fullPath,
        size: 0,
        isDirectory: true,
        mtime: stat.mtimeMs,
        extension: '',
      });
      walkReferences(fullPath, root, out);
    } else if (entry.isFile()) {
      out.push({
        name: entry.name,
        relativePath,
        absolutePath: fullPath,
        size: stat.size,
        isDirectory: false,
        mtime: stat.mtimeMs,
        extension: getExtension(entry.name),
      });
    }
  }
}

/**
 * Find a non-colliding destination name in `dir` for `originalName`.
 * Appends ` (1)`, ` (2)`, ... before the extension when needed.
 */
function resolveCollisionName(dir: string, originalName: string): string {
  if (!fs.existsSync(path.join(dir, originalName))) return originalName;
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot) : '';
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  // Extremely unlikely fallback — append a uuid-ish suffix.
  return `${stem} (${Date.now()})${ext}`;
}

export function registerReferencesHandlers(): void {
  const logger = getLogger();

  ipcMain.handle('references:list', async (_event, workingDirectory: string): Promise<ReferencesResult<ReferenceEntry[]>> => {
    try {
      if (!workingDirectory || typeof workingDirectory !== 'string') {
        return { success: false, error: 'Invalid working directory' };
      }
      const root = path.join(workingDirectory, '.duya', 'references');
      if (!fs.existsSync(root)) {
        return { success: true, data: [] };
      }
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) {
        return { success: false, error: '.duya/references exists but is not a directory' };
      }
      const entries: ReferenceEntry[] = [];
      walkReferences(root, root, entries);
      // Sort: directories first, then files; alphabetical within each group.
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      return { success: true, data: entries };
    } catch (error) {
      logger.warn('references:list error', { error: String(error) }, LogComponent.Files);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(
    'references:pick-files',
    async (_event, options?: { title?: string; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }> => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { canceled: true, filePaths: [] };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: options?.title || 'Select reference files',
        defaultPath: options?.defaultPath || undefined,
        properties: ['openFile', 'multiSelections'],
      });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );

  ipcMain.handle(
    'references:add',
    async (_event, workingDirectory: string, filePaths: string[]): Promise<ReferencesResult<string[]>> => {
      try {
        if (!workingDirectory || typeof workingDirectory !== 'string') {
          return { success: false, error: 'Invalid working directory' };
        }
        if (!Array.isArray(filePaths) || filePaths.length === 0) {
          return { success: false, error: 'No files provided' };
        }
        const root = path.join(workingDirectory, '.duya', 'references');
        fs.mkdirSync(root, { recursive: true });
        const added: string[] = [];
        for (const src of filePaths) {
          if (typeof src !== 'string' || !src) continue;
          if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
            logger.warn('references:add skipping non-file source', { src }, LogComponent.Files);
            continue;
          }
          const baseName = path.basename(src);
          const destName = resolveCollisionName(root, baseName);
          const dest = path.join(root, destName);
          try {
            fs.copyFileSync(src, dest);
            added.push(destName);
          } catch (copyErr) {
            logger.warn('references:add copy failed', { src, dest, error: String(copyErr) }, LogComponent.Files);
          }
        }
        return { success: true, data: added };
      } catch (error) {
        logger.warn('references:add error', { error: String(error) }, LogComponent.Files);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'references:delete',
    async (_event, workingDirectory: string, relativePath: string): Promise<ReferencesResult> => {
      try {
        const resolved = resolveInsideReferences(workingDirectory, relativePath);
        if (!resolved.ok) {
          logger.warn('references:delete path rejected', { relativePath }, LogComponent.Files);
          return { success: false, error: resolved.error };
        }
        if (!fs.existsSync(resolved.absolute)) {
          return { success: false, error: 'File or directory does not exist' };
        }
        const stat = fs.statSync(resolved.absolute);
        if (stat.isDirectory()) {
          fs.rmSync(resolved.absolute, { recursive: true, force: true });
        } else {
          fs.unlinkSync(resolved.absolute);
        }
        return { success: true };
      } catch (error) {
        logger.warn('references:delete error', { error: String(error) }, LogComponent.Files);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'references:open',
    async (_event, workingDirectory: string, relativePath: string): Promise<ReferencesResult> => {
      try {
        const resolved = resolveInsideReferences(workingDirectory, relativePath);
        if (!resolved.ok) {
          return { success: false, error: resolved.error };
        }
        if (!fs.existsSync(resolved.absolute)) {
          return { success: false, error: 'File does not exist' };
        }
        const stat = fs.statSync(resolved.absolute);
        if (stat.isDirectory()) {
          return { success: false, error: 'Cannot open a directory' };
        }
        await shell.openPath(resolved.absolute);
        return { success: true };
      } catch (error) {
        logger.warn('references:open error', { error: String(error) }, LogComponent.Files);
        return { success: false, error: String(error) };
      }
    },
  );
}
