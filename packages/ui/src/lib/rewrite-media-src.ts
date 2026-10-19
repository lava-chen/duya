// Extracted from `components/chat/markdownComponents.tsx` (plan 610/24 shared
// renderer). `ImagePreview` imports it while `markdownComponents` renders
// `ImagePreview`, so keeping the utility there was a component->component
// import cycle; a self-contained path-rewriting helper belongs in `lib/`.

// Detect a Windows absolute path like `C:/...` or `C:\...`. Unix
// absolute paths start with `/`; the renderer treats `/...` as a URL
// scheme so we must distinguish "filesystem path" from "URL with a
// weird scheme".
function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}
function isUnixAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

// react-markdown parses `c:/Users/foo/a.png` as a URL whose scheme is `c`,
// host is `c`, and pathname is `/Users/foo/a.png`. When it later
// reconstructs the string for our custom `img` component, it glues the
// host and pathname back together without the colon, so `src` arrives as
// `c/Users/foo/a.png` — no leading slash, no drive-letter colon. Detect
// that case by looking for a single letter followed by a typical Windows
// top-level directory (Users, Windows, Program Files, ProgramData, ...),
// then promote it back to a proper `C:/...` absolute path.
const WINDOWS_DRIVE_LETTER_RE = /^[a-zA-Z]$/;
function isColonStrippedWindowsPath(value: string): boolean {
  if (value.length < 3) return false;
  if (!WINDOWS_DRIVE_LETTER_RE.test(value[0])) return false;
  if (value[1] !== '/') return false;
  // The 2nd path segment (after the drive letter) must be a known Windows
  // top-level directory. This avoids misclassifying short relative paths
  // like `a/b` as Windows absolute paths.
  const secondSlash = value.indexOf('/', 2);
  const secondSegment = secondSlash === -1 ? value.slice(2) : value.slice(2, secondSlash);
  return (
    secondSegment === 'Users' ||
    secondSegment === 'Windows' ||
    secondSegment === 'Program Files' ||
    secondSegment === 'Program Files (x86)' ||
    secondSegment === 'ProgramData'
  );
}
function restoreColonStrippedWindowsPath(value: string): string {
  return `${value[0]}:${value.slice(1)}`;
}

/**
 * Rewrite a markdown image `src` so the renderer can actually load it.
 * Standard web URLs pass through unchanged. Absolute filesystem paths
 * are mapped to the `duya-file://` custom protocol registered in the
 * Electron main process; agents never have to write `duya-file://`
 * themselves.
 */
// The finalAnswer prompt teaches the LLM to reference absolute paths with a
// `/abs/path` placeholder prefix. On Windows the agent sometimes prepends that
// placeholder to a real path (e.g. `/abs/path/C:/...`), which would otherwise
// resolve to a nonexistent file. Strip it and re-evaluate so the real path wins.
const ABS_PATH_PLACEHOLDER = '/abs/path';
export function rewriteMediaSrc(src: string): string {
  if (!src) return src;
  // Windows absolute paths look like `C:/...` or `C:\...` — the `C:`
  // prefix could be mistaken for a URL scheme, so check this first.
  if (isWindowsAbsolutePath(src)) {
    return `duya-file:///${src.replace(/\\/g, '/')}`;
  }
  // react-markdown sometimes drops the drive-letter colon when it parses
  // `c:/Users/...` as a URL with scheme `c`, host `c`, pathname `/Users/...`
  // and concatenates them back without the colon (see
  // `c/Users/lavachen/AppData/Local/Temp/blender_screenshot_v1.png` in the
  // issue). Restore the colon so the Windows-absolute branch above matches.
  if (isColonStrippedWindowsPath(src)) {
    return rewriteMediaSrc(restoreColonStrippedWindowsPath(src));
  }
  // `file://` URLs (the one non-http scheme SendMessage validates for bot
  // images) are blocked by Chromium on an http-origin renderer page, so the
  // local file would never load. Map them to the app's `duya-file://` protocol
  // so the Electron main process can serve the file. `file:///C:/...` and
  // `file://C:/...` both resolve via the protocol handler's drive recovery.
  if (/^file:/i.test(src)) {
    return `duya-file:///${src.slice(5).replace(/^\/+/, '')}`;
  }
  // Scheme-bearing URL (`http:`, `https:`, `data:`, `blob:`, ...) passes
  // through. Anything else that begins with `/` is a Unix absolute path.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src;
  if (isUnixAbsolutePath(src)) {
    // Models emit the taught `/abs/path/` placeholder and a shortened
    // `/abs/` variant; strip either when a real Windows drive path follows
    // (e.g. `/abs/E:/Projects/a.png` → `E:/Projects/a.png`).
    for (const prefix of [ABS_PATH_PLACEHOLDER, '/abs']) {
      const withSlash = `${prefix}/`;
      if (src.startsWith(withSlash)) {
        const stripped = src.slice(prefix.length).replace(/^\/+/, '');
        if (isWindowsAbsolutePath(stripped)) {
          return `duya-file:///${stripped.replace(/\\/g, '/')}`;
        }
      }
    }
    return `duya-file://${src}`;
  }
  return src;
}
