/**
 * Plan-file path resolution + write-target gating (grok `plan_mode.rs`).
 *
 * grok anchors the plan file to the session directory:
 *   `~/.grok/sessions/<cwd>/<session_id>/plan.md`
 *
 * duya uses its own Codex-style session root (`~/.duya/sessions/`), so the
 * plan file is a fixed, session-scoped absolute path:
 *   `~/.duya/sessions/<sanitized-session-id>/plan.md`
 *
 * This is a hard constraint, not something the agent chooses: the plan-mode
 * reminder points the model at this exact path, and the write gate in
 * `ModeCoordinator.gateWriteTool` only allows edits that resolve to it.
 */

import { homedir } from 'os';
import { join, normalize } from 'path';

/** Markdown suffixes accepted for plan-mode writes (grok `is_markdown_file_path`). */
const MARKDOWN_SUFFIXES = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx'];

/** Replace characters invalid in Windows filenames so session IDs stay safe on disk. */
function sanitizeFilenameSegment(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
}

/**
 * Resolve the absolute path to the session plan file. Deterministic per
 * session id, so the model-facing reminder and the write gate agree.
 */
export function resolvePlanFilePath(sessionId: string): string {
  return join(
    homedir(),
    '.duya',
    'sessions',
    sanitizeFilenameSegment(sessionId || 'default'),
    'plan.md',
  );
}

/**
 * Exact-match write check (grok `is_plan_file_write`): `targetPath` is only
 * allowed when it equals the plan file. Comparing normalized paths keeps
 * accidental separator/`..` differences from bypassing the gate.
 */
export function isPlanFileWrite(targetPath: string, planFile: string): boolean {
  return normalize(targetPath) === normalize(planFile);
}

/** Whether a path's final component is a markdown file (case-insensitive). */
export function isMarkdownFilePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return MARKDOWN_SUFFIXES.some((suffix) => name.endsWith(suffix));
}