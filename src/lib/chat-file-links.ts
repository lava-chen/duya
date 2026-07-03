const HTML_EXTENSIONS = new Set(['.html', '.htm']);

const LOCAL_FILE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv',
  '.html', '.htm', '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.py', '.rs',
  '.go', '.java', '.kt', '.swift', '.cs', '.cpp', '.c', '.h', '.hpp',
]);

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, '');
}

export function fileNameFromPath(filePath: string): string {
  const clean = stripLineSuffix(filePath).replace(/\\/g, '/');
  return clean.split('/').pop() || filePath;
}

export function extensionFromPath(filePath: string): string {
  const name = fileNameFromPath(filePath).toLowerCase();
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx) : '';
}

export function isHtmlFile(filePath: string): boolean {
  return HTML_EXTENSIONS.has(extensionFromPath(filePath));
}

const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']);
const SIDEBAR_PREVIEW_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
]);

/** Office docs that should open in DUYA's side-panel Office viewer. */
export function isOfficeFile(filePath: string): boolean {
  return OFFICE_EXTENSIONS.has(extensionFromPath(filePath));
}

/** Files that should open in DUYA's read-only side-panel preview workspace. */
export function isSidebarPreviewFile(filePath: string): boolean {
  return SIDEBAR_PREVIEW_EXTENSIONS.has(extensionFromPath(filePath));
}

function defaultPreviewRootForFile(resolvedPath: string, cwd?: string | null): string {
  if (cwd && cwd.trim()) return cwd;
  const normalized = resolvedPath.replace(/\//g, '\\');
  const lastSeparator = normalized.lastIndexOf('\\');
  if (lastSeparator > 0) return normalized.slice(0, lastSeparator);
  return normalized;
}

/**
 * Detect `http://localhost[:port][/path]` and `http://127.0.0.1[:port][/path]`
 * style URLs. We intentionally do NOT match `0.0.0.0` here — that hostname is
 * rarely what a user wants to click, and `0.0.0.0` on a link usually means
 * "the server bound to all interfaces", which the user can reach via
 * `localhost` instead.
 *
 * Used by the markdown autolink handler so an in-chat `http://localhost:8000/`
 * opens in DUYA's side-panel browser instead of leaking to an external tab.
 */
export function isLocalhostUrl(value: string): boolean {
  const clean = value.trim();
  if (!clean) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s'"]*)?$/i.test(clean);
}

export function isLikelyLocalFileReference(value: string): boolean {
  const clean = stripLineSuffix(value.trim());
  if (!clean) return false;
  if (/^file:\/\//i.test(clean)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(clean)) return true;
  if (clean.startsWith('./') || clean.startsWith('../')) return true;
  if (clean.startsWith('/') || clean.startsWith('\\')) return true;
  return LOCAL_FILE_EXTENSIONS.has(extensionFromPath(clean));
}

export function resolveLocalFilePath(value: string, cwd?: string | null): string {
  let clean = stripLineSuffix(value.trim());
  if (/^file:\/\//i.test(clean)) {
    try {
      clean = decodeURIComponent(new URL(clean).pathname);
      if (/^\/[a-zA-Z]:\//.test(clean)) {
        clean = clean.slice(1);
      }
    } catch {
      clean = clean.replace(/^file:\/\/\/?/i, '');
    }
  }
  clean = clean.replace(/\//g, '\\');
  if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith('\\\\')) {
    return clean;
  }
  if (cwd) {
    return `${cwd.replace(/[\\/]+$/, '')}\\${clean.replace(/^[\\/]+/, '')}`;
  }
  return clean;
}

export function openLocalFileTarget(filePath: string, cwd?: string | null): void {
  const resolved = resolveLocalFilePath(filePath, cwd);
  if (isHtmlFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-browser-panel', {
      detail: { url: resolved },
    }));
    return;
  }
  if (isOfficeFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-office-panel', {
      detail: { filePath: resolved, workingDirectory: cwd || null },
    }));
    return;
  }

  if (window.electronAPI?.shell?.openPath) {
    void window.electronAPI.shell.openPath(resolved);
    return;
  }

  window.open(`file:///${encodeURI(resolved.replace(/\\/g, '/'))}`, '_blank');
}

/**
 * Artifact cards should prefer DUYA's internal surfaces over external apps:
 * HTML → Browser panel, Office → Office panel, previewable local assets →
 * Preview panel. Falls back to the generic local-file handler otherwise.
 */
export function openLocalArtifactTarget(filePath: string, cwd?: string | null): void {
  const resolved = resolveLocalFilePath(filePath, cwd);
  if (isHtmlFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-browser-panel', {
      detail: { url: resolved },
    }));
    return;
  }
  if (isOfficeFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-office-panel', {
      detail: { filePath: resolved, workingDirectory: defaultPreviewRootForFile(resolved, cwd) },
    }));
    return;
  }
  if (isSidebarPreviewFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-file-preview-panel', {
      detail: {
        filePath: resolved,
        workingDirectory: defaultPreviewRootForFile(resolved, cwd),
      },
    }));
    return;
  }
  openLocalFileTarget(resolved, cwd);
}

export function fileKindLabel(filePath: string): string {
  const ext = extensionFromPath(filePath);
  if (!ext) return 'File';
  if (ext === '.md' || ext === '.markdown') return 'Markdown';
  if (ext === '.html' || ext === '.htm') return 'HTML';
  if (ext === '.pdf') return 'PDF';
  if (ext === '.doc' || ext === '.docx') return 'Document';
  if (ext === '.ppt' || ext === '.pptx') return 'Slides';
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') return 'Sheet';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'Image';
  return ext.slice(1).toUpperCase();
}

export function isDeliverableFile(filePath: string): boolean {
  const ext = extensionFromPath(filePath);
  return [
    '.md', '.markdown', '.html', '.htm', '.pdf', '.doc', '.docx', '.ppt',
    '.pptx', '.xls', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.svg',
  ].includes(ext);
}
