/**
 * ipc/files-handlers.ts - File operations IPC handlers
 *
 * Handlers for:
 * - File tree browsing
 * - Read-only file previews
 * - File/folder deletion
 * - File/folder renaming
 */

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getLogger, LogComponent } from '../logging/logger';

interface FileTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  extension?: string;
  children?: FileTreeNode[];
}

type FilePreviewKind = 'text' | 'image' | 'pdf' | 'unsupported';

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 12 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'mdx', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'css',
  'scss', 'sass', 'less', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'env', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'swift', 'm', 'mm', 'sql', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'dockerfile', 'gitignore',
  'editorconfig', 'properties', 'gradle', 'cmake', 'vue', 'svelte', 'astro',
  'graphql', 'gql', 'proto', 'csv', 'tsv', 'log', 'lock',
]);

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  if (targetPath === rootPath) return true;
  const relative = path.relative(rootPath, targetPath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function previewKind(extension: string | undefined): FilePreviewKind {
  if (!extension) return 'text';
  if (extension in IMAGE_MEDIA_TYPES) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'unsupported';
}

const IGNORED_ENTRIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '*.log',
]);

const VISIBLE_DOT_DIRS = new Set([
  '.agents',
  '.claude',
  '.duya',
]);

function shouldIgnore(name: string): boolean {
  if (VISIBLE_DOT_DIRS.has(name)) return false;
  if (IGNORED_ENTRIES.has(name)) return true;
  if (name.startsWith('.')) return true;
  if (name.endsWith('.log')) return true;
  return false;
}

function getExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

function buildFileTree(dirPath: string, baseDir: string, depth: number, maxDepth: number): FileTreeNode[] {
  if (depth > maxDepth) return [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        const children = buildFileTree(fullPath, baseDir, depth + 1, maxDepth);
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          children,
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
          extension: getExtension(entry.name),
        });
      }
    }

    nodes.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === 'directory' ? -1 : 1;
    });

    return nodes;
  } catch (error) {
    const logger = getLogger();
    logger.error('Failed to read directory', error instanceof Error ? error : new Error(String(error)), { dirPath }, LogComponent.Files);
    return [];
  }
}

export function registerFilesHandlers(): void {
  ipcMain.handle('files:browse', async (_event, dirPath: string, rootPath: string, maxDepth = 4) => {
    try {
      if (!dirPath || typeof dirPath !== 'string') {
        return { success: false, error: 'Invalid directory path', tree: [] };
      }
      // rootPath is required for path-safety (plan 413): every
      // renderer-supplied dirPath must be anchored inside the user
      // project workspace, otherwise a compromised renderer could
      // enumerate the host filesystem by passing a top-level dir.
      if (!rootPath || typeof rootPath !== 'string') {
        return { success: false, error: 'Root path is required', tree: [] };
      }
      const resolvedRoot = path.resolve(rootPath);
      if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
        return { success: false, error: 'Project directory does not exist', tree: [] };
      }
      const realRoot = fs.realpathSync(resolvedRoot);

      const resolvedPath = path.resolve(dirPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Directory does not exist', tree: [] };
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return { success: false, error: 'Path is not a directory', tree: [] };
      }

      // realpathSync resolves any symlinks before the isInsideRoot
      // comparison so a symlink inside the workspace cannot redirect
      // the walk to /etc or ~/.ssh.
      const realTarget = fs.realpathSync(resolvedPath);
      if (!isInsideRoot(realTarget, realRoot)) {
        return { success: false, error: 'Directory is outside the project root', tree: [] };
      }

      const tree = buildFileTree(realTarget, realTarget, 0, maxDepth);
      return { success: true, tree };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:browse error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error), tree: [] };
    }
  });
  ipcMain.handle(
    'files:preview',
    async (_event, targetPath: string, rootPath: string, options?: { standalone?: boolean }) => {
    try {
      // Standalone mode (opt-in via options.standalone === true): the
      // renderer only sets this when the user explicitly clicked an
      // in-chat link to a file outside the chat workspace. To prevent
      // the renderer from previewing host-system files (e.g. /etc/passwd),
      // we still gate the target: in standalone mode the real target
      // must live under os.homedir() (plan 413). Non-standalone mode
      // keeps the project-root isInsideRoot check.
      const standalone = options?.standalone === true;

      if (!targetPath || typeof targetPath !== 'string') {
        return { success: false, error: 'Invalid preview path' };
      }
      if (!standalone && (!rootPath || typeof rootPath !== 'string')) {
        return { success: false, error: 'Invalid preview path' };
      }

      const resolvedTarget = path.resolve(targetPath);
      if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isFile()) {
        return { success: false, error: 'Preview file does not exist' };
      }

      const realTarget = fs.realpathSync(resolvedTarget);

      if (standalone) {
        const homeDir = os.homedir();
        if (!isInsideRoot(realTarget, homeDir)) {
          return { success: false, error: 'Preview path is outside the user home directory' };
        }
      } else {
        const resolvedRoot = path.resolve(rootPath);
        if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
          return { success: false, error: 'Project directory does not exist' };
        }
        const realRoot = fs.realpathSync(resolvedRoot);
        if (!isInsideRoot(realTarget, realRoot)) {
          return { success: false, error: 'Preview path is outside the project directory' };
        }
      }

      const stat = fs.statSync(realTarget);
      const extension = getExtension(path.basename(realTarget));
      const kind = previewKind(extension);
      const base = {
        success: true,
        kind,
        name: path.basename(realTarget),
        path: realTarget,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        extension,
      };

      if (kind === 'unsupported') {
        return base;
      }

      if (kind === 'text') {
        const bytesToRead = Math.min(stat.size, MAX_TEXT_PREVIEW_BYTES);
        const fd = fs.openSync(realTarget, 'r');
        try {
          const buffer = Buffer.alloc(bytesToRead);
          const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
          const contentBuffer = buffer.subarray(0, bytesRead);
          if (contentBuffer.includes(0)) {
            return { ...base, kind: 'unsupported' as const };
          }
          return {
            ...base,
            content: contentBuffer.toString('utf8'),
            truncated: stat.size > MAX_TEXT_PREVIEW_BYTES,
          };
        } finally {
          fs.closeSync(fd);
        }
      }

      if (stat.size > MAX_BINARY_PREVIEW_BYTES) {
        return {
          ...base,
          error: 'File is too large to preview',
          tooLarge: true,
        };
      }

      const data = fs.readFileSync(realTarget).toString('base64');
      const mediaType = kind === 'pdf' ? 'application/pdf' : IMAGE_MEDIA_TYPES[extension ?? ''];
      return { ...base, data, mediaType };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:preview error', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Files);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('files:delete', async (_event, targetPath: string, rootPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string') {
        return { success: false, error: 'Invalid path' };
      }
      if (!rootPath || typeof rootPath !== 'string') {
        return { success: false, error: 'Root path is required' };
      }
      const resolvedRoot = path.resolve(rootPath);
      if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
        return { success: false, error: 'Project directory does not exist' };
      }
      const realRoot = fs.realpathSync(resolvedRoot);

      const resolvedPath = path.resolve(targetPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Path does not exist' };
      }
      const realTarget = fs.realpathSync(resolvedPath);
      if (!isInsideRoot(realTarget, realRoot)) {
        return { success: false, error: 'Path is outside the project root' };
      }

      const stat = fs.statSync(realTarget);
      if (stat.isDirectory()) {
        fs.rmdirSync(realTarget, { recursive: true });
      } else {
        fs.unlinkSync(realTarget);
      }

      return { success: true };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:delete error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });
  ipcMain.handle('files:rename', async (_event, targetPath: string, newName: string, rootPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string' || !newName || typeof newName !== 'string') {
        return { success: false, error: 'Invalid path or name' };
      }
      if (!rootPath || typeof rootPath !== 'string') {
        return { success: false, error: 'Root path is required' };
      }
      const resolvedRoot = path.resolve(rootPath);
      if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
        return { success: false, error: 'Project directory does not exist' };
      }
      const realRoot = fs.realpathSync(resolvedRoot);

      const resolvedPath = path.resolve(targetPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Path does not exist' };
      }
      const realTarget = fs.realpathSync(resolvedPath);
      if (!isInsideRoot(realTarget, realRoot)) {
        return { success: false, error: 'Path is outside the project root' };
      }

      const parentDir = path.dirname(realTarget);
      const newPath = path.join(parentDir, newName);

      // The rename destination must also stay inside the same root:
      // a symlinked parentDir cannot bypass the isInsideRoot test.
      const realParentDir = fs.realpathSync(parentDir);
      const realNewPath = path.join(realParentDir, newName);
      if (!isInsideRoot(realNewPath, realRoot)) {
        return { success: false, error: 'Renamed path would escape the project root' };
      }

      if (fs.existsSync(newPath)) {
        return { success: false, error: 'A file or folder with that name already exists' };
      }

      fs.renameSync(realTarget, newPath);
      return { success: true, newPath };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:rename error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });
}
