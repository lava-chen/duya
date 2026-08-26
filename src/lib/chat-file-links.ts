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
// Files that should open in DUYA's read-only side-panel preview workspace.
// Aligns with the Electron `TEXT_EXTENSIONS` allow-list in
// `electron/ipc/files-handlers.ts` so any source file the backend can render
// as text also routes through the preview panel when clicked from a chat
// tool row, a markdown autolink, or the EditSummaryCard "Review" list.
//
// HTML/HTM is intentionally absent — those route to the side-panel browser
// (and that branch fires first in `openLocalArtifactTarget`). XML is also
// absent because the preview backend treats XML as a separate kind, not
// text, and rendering it through the plain-text preview produces noise.
const SIDEBAR_PREVIEW_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.csv',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  // Web / scripting
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.less',
  // Systems / compiled
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift',
  '.cs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  // Shell / SQL
  '.sh', '.bash', '.zsh', '.fish', '.sql',
  // Build / config (filenames like Dockerfile / .gitignore are matched by
  // the backend by name — see electron TEXT_EXTENSIONS — but the frontend
  // extension lookup can't cheaply express that without a name→ext map.
  // Covering the most common extension-bearing paths here.)
  '.toml', '.ini', '.cfg', '.conf', '.env',
  '.vue', '.svelte', '.astro', '.graphql', '.gql', '.proto',
  '.log', '.lock',
]);

/** Office docs that should open in DUYA's side-panel Office viewer. */
export function isOfficeFile(filePath: string): boolean {
  return OFFICE_EXTENSIONS.has(extensionFromPath(filePath));
}

/** Files that should open in DUYA's read-only side-panel preview workspace. */
export function isSidebarPreviewFile(filePath: string): boolean {
  return SIDEBAR_PREVIEW_EXTENSIONS.has(extensionFromPath(filePath));
}

/** Extract the directory part of a path without pulling in the Node
 *  `path` module (renderer should stay lightweight). Mirrors the
 *  implementation in FilePreviewPanel.tsx. */
function getDirectoryPath(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

/** Check whether `target` is inside `root` using pure string comparison
 *  so the helper works in the renderer without the Node `path` module.
 *  Both Windows and Unix separators are handled. Exported so callers
 *  (e.g. MarkdownAnchor) can decide whether a resolved href lives
 *  outside the chat workspace and should therefore open as a
 *  "single-file" preview without exposing its parent directory as
 *  the panel's project root. */
export function isPathInsideRoot(target: string, root: string): boolean {
  const normTarget = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normTarget.startsWith(normRoot + '/') && normTarget !== normRoot) return false;
  return true;
}

function defaultPreviewRootForFile(resolvedPath: string, cwd?: string | null): string {
  const fileDir = getDirectoryPath(resolvedPath);
  const cwdRaw = cwd?.trim();
  if (!cwdRaw) return fileDir;

  // When the file is inside the supplied working directory, keep the cwd
  // as the preview root so the panel's file tree shows the project context.
  // If the file lives elsewhere (e.g. a Read tool result pointing at another
  // project), fall back to the file's own directory so files:preview does not
  // reject it as "outside the project directory".
  const inside = isPathInsideRoot(resolvedPath, cwdRaw);
  return inside ? cwdRaw : fileDir;
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
  // Any other URI scheme (http/https/ftp/github:, ...) is a web link, not
  // a local file — even when its path ends in a file-like extension such
  // as `.html` / `.pdf` / `.md`. Without this guard, `[doc](https://x.com/a.pdf)`
  // would be misclassified as a local file and never reach the external-link
  // (favicon) branch.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(clean)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(clean)) return true;
  if (clean.startsWith('./') || clean.startsWith('../')) return true;
  if (clean.startsWith('/') || clean.startsWith('\\')) return true;
  return LOCAL_FILE_EXTENSIONS.has(extensionFromPath(clean));
}

/** Collapse `.` and `..` segments of `rel` onto `base` using pure string
 *  ops (the renderer stays free of the Node `path` module). `rel` must
 *  already use `separator`. Spurious empty segments from doubled
 *  separators (`E:\\a`) are dropped, and `..` clamps at the volume / UNC /
 *  Unix-root prefix instead of climbing above it. */
function joinAndNormalizeSegments(base: string, rel: string, separator: string): string {
  const isUnc = /^\\\\/.test(base);
  const isWindows = /^[a-zA-Z]:/.test(base);
  let prefix: string;
  let body: string;
  if (isUnc) {
    // Keep `\\server\share` (or at least `\\server`) as the root.
    const m = /^(\\\\[^\\/]+(?:\\[^\\/]+)?)/.exec(base);
    prefix = m?.[1] ?? base;
    body = base.slice(prefix.length);
  } else if (isWindows) {
    prefix = base.match(/^[a-zA-Z]:/)?.[0] ?? '';
    body = base.slice(prefix.length);
  } else if (base.startsWith(separator)) {
    prefix = separator;
    body = base.slice(separator.length);
  } else {
    prefix = '';
    body = base;
  }

  const stack = body.split(separator).filter(Boolean);
  for (const part of rel.split(separator)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      // Clamp at the root: never pop the volume/UNC/Unix-root prefix.
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  const joinedBody = stack.join(separator);
  if (!prefix) return joinedBody;
  if (prefix === separator) {
    // Unix root: `/` + body.
    return prefix + joinedBody;
  }
  return `${prefix}${separator}${joinedBody}`;
}

export function resolveLocalFilePath(value: string, cwd?: string | null): string {
  let clean = stripLineSuffix(value.trim());

  const isWindowsAbsolute = (p: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(p);
  const isUnixAbsolute = (p: string) => p.startsWith('/');

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

  // The finalAnswer prompt teaches the LLM to prefix absolute paths with a
  // `/abs/path` placeholder. When it precedes a Windows absolute path (e.g.
  // `/abs/path/C:/...`), strip it so the real path wins — the placeholder
  // would otherwise resolve to a nonexistent drive-relative path. Mirrors
  // the media-src handling in rewriteMediaSrc.
  // Models also emit the shortened `/abs/C:/...` variant; strip that too.
  const ABS_PREFIXES = ['/abs/path', '/abs'];
  for (const prefix of ABS_PREFIXES) {
    if (clean.startsWith(`${prefix}/`)) {
      const stripped = clean.slice(prefix.length).replace(/^\/+/, '');
      if (isWindowsAbsolute(stripped)) {
        clean = stripped;
        break;
      }
    }
  }

  // Windows absolute path: normalize to backslashes and return as-is.
  if (isWindowsAbsolute(clean)) {
    return clean.replace(/\//g, '\\');
  }

  // Unix absolute path: normalize to forward slashes and return as-is.
  if (isUnixAbsolute(clean)) {
    return clean.replace(/\\/g, '/');
  }

  // Relative path: derive the separator from cwd when available.
  if (cwd) {
    const cwdRaw = cwd.trim();
    const separator = isWindowsAbsolute(cwdRaw) ? '\\' : '/';
    const normalizedCwd = cwdRaw.replace(/[\\/]+$/, '');
    const normalizedClean = clean.replace(/^[\\/]+/, '').replace(/\\/g, separator).replace(/\//g, separator);
    return joinAndNormalizeSegments(normalizedCwd, normalizedClean, separator);
  }

  // No cwd: keep the input's dominant separator style.
  if (clean.includes('\\') && !clean.includes('/')) {
    return clean;
  }
  return clean.replace(/\\/g, '/');
}

export function openLocalFileTarget(filePath: string, cwd?: string | null): void {
  const resolved = resolveLocalFilePath(filePath, cwd);
  if (isHtmlFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-browser-panel', {
      detail: { url: resolved },
    }));
    return;
  }

  // Everything else — office docs (xlsx/pptx/docx), directories, binaries,
  // unknown extensions — opens with the OS default app. `shell.openPath`
  // launches a file with its registered app and opens a folder in the file
  // manager, so AI-provided path links "just work" instead of silently
  // doing nothing.
  if (window.electronAPI?.shell?.openPath) {
    void window.electronAPI.shell.openPath(resolved);
    return;
  }

  window.open(`file:///${encodeURI(resolved.replace(/\\/g, '/'))}`, '_blank');
}

/**
 * Internal canvas links emitted by the agent in chat markdown, e.g.
 * `[canvas](/duya/canvas/<canvasId>)`. These are app routes, not
 * filesystem paths — without this parser they would fall into the
 * local-file pill branch (any `/...` path classifies as local) and
 * clicking would try `shell.openPath` on a nonexistent file.
 * The `duya://canvas/<id>` scheme form is accepted as a tolerant alias.
 */
const CANVAS_PATH_LINK_RE = /^\/duya\/canvas\/([A-Za-z0-9][A-Za-z0-9-]*)\/?$/;
const CANVAS_SCHEME_LINK_RE = /^duya:\/\/canvas\/([A-Za-z0-9][A-Za-z0-9-]*)\/?$/i;

/** Return the canvasId when `href` is an internal canvas route, else null. */
export function parseInternalCanvasLink(href: string): string | null {
  const clean = href.trim();
  const match = CANVAS_PATH_LINK_RE.exec(clean) ?? CANVAS_SCHEME_LINK_RE.exec(clean);
  return match ? match[1] : null;
}

/**
 * Open a canvas in the sidebar Conductor panel. Routed through the same
 * window-event channel as the browser/file-preview/office panels so any
 * renderer surface (markdown links, tool rows) can trigger it without a
 * direct provider dependency. `dedupKey` folds on `canvasId`, so repeated
 * clicks activate the existing tab instead of stacking duplicates.
 */
export function openConductorCanvas(canvasId: string): void {
  if (!canvasId.trim()) return;
  window.dispatchEvent(new CustomEvent('duya:open-conductor-panel', {
    detail: { canvasId },
  }));
}

/** Optional line range carried from a chat tool row (e.g. ReadTool) to
 *  the file preview panel, so the panel can scroll to and highlight the
 *  exact lines the agent read. `end` is optional and 1-indexed; when
 *  omitted only `start` is focused. */
export interface FocusLineRange {
  start: number;
  end?: number;
}

/**
 * Artifact cards should prefer DUYA's internal surfaces over external apps:
 * HTML → Browser panel, Office → Office panel, previewable local assets →
 * Preview panel. Falls back to the generic local-file handler otherwise.
 *
 * When `lineRange` is supplied for a previewable file, the preview panel
 * both opens (or activates) with the line range in its params and receives
 * a follow-up `duya:preview-focus-lines` event. The follow-up matters when
 * a tab for this file is already open — `dedupKey` would only activate the
 * existing tab without re-running its params, so the event is what actually
 * drives the scroll-to-line in that case.
 */
export function openLocalArtifactTarget(
  filePath: string,
  cwd?: string | null,
  lineRange?: FocusLineRange,
  options?: { standalone?: boolean },
): void {
  const resolved = resolveLocalFilePath(filePath, cwd);
  if (isHtmlFile(resolved)) {
    window.dispatchEvent(new CustomEvent('duya:open-browser-panel', {
      detail: { url: resolved },
    }));
    return;
  }
  if (isSidebarPreviewFile(resolved)) {
    const hasLineRange =
      !!lineRange &&
      Number.isFinite(lineRange.start) &&
      lineRange.start > 0;
    // Standalone mode: the caller knows the file lives outside the chat
    // workspace (e.g. the agent pointed at ~/Downloads/notes.md while the
    // active thread cwd is a different project). In that case we don't
    // want the preview panel to mount the file's directory as its
    // project root — that previously caused the integrated file tree to
    // expose arbitrary external directories. Passing an empty
    // workingDirectory tells the panel to render the file alone (no
    // tree, no breadcrumb root); the IPC skips isInsideRoot as well.
    // Default behavior (options.standalone falsy) is unchanged so the
    // sidebar file preview's relative-link case keeps its existing
    // fallback to the file's own directory.
    const standalone = options?.standalone === true;
    const detail: {
      filePath: string;
      workingDirectory: string;
      standalone?: boolean;
      lineStart?: number;
      lineEnd?: number;
    } = {
      filePath: resolved,
      workingDirectory: standalone ? '' : defaultPreviewRootForFile(resolved, cwd),
    };
    if (standalone) detail.standalone = true;
    if (hasLineRange) {
      detail.lineStart = lineRange!.start;
      if (Number.isFinite(lineRange!.end) && lineRange!.end! >= lineRange!.start) {
        detail.lineEnd = lineRange!.end;
      }
    }
    window.dispatchEvent(new CustomEvent('duya:open-file-preview-panel', { detail }));
    // Re-broadcast as a focus-lines event so an already-open tab for this
    // file (matched by filePath) can scroll to the new range without
    // requiring a fresh tab. Skipped when there's no line range to focus.
    if (hasLineRange) {
      window.dispatchEvent(new CustomEvent('duya:preview-focus-lines', {
        detail: {
          filePath: resolved,
          lineStart: detail.lineStart,
          lineEnd: detail.lineEnd,
        },
      }));
    }
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
