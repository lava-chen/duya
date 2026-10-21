/**
 * sanitizeWorkingDirectory - asar-safe working directory resolution.
 *
 * In the packaged Electron main process, `process.cwd()` resolves to the
 * app install dir (e.g. `C:\Program Files\duya\resources\app.asar` or its
 * parent), NOT the user's current project. Tools that fall back to
 * process.cwd() at module-init or execute time end up silently scanning the
 * install bundle, the user gets noise and the system gets the wrong results.
 *
 * The agent layer resolves the live project cwd from session/tool context
 * (see StreamingToolExecutor.options.workingDirectory) and threads it
 * through every tool's `execute(input, workingDirectory?, context?)` call.
 * This helper exists so tools can validate the value once instead of
 * checking against process.cwd() at every call site.
 *
 * Behavior:
 *   - Returns `undefined` for missing/empty/asar/relative/non-existent
 *     inputs so the caller can fall back or fail loudly.
 *   - Returns the absolute, verified-exists directory otherwise.
 *   - Never throws — sanitization is a soft check, the tool error path
 *     surfaces the user-facing message.
 */
import { statSync } from 'node:fs';

export function sanitizeWorkingDirectory(cwd: string | undefined | null): string | undefined {
  if (!cwd) return undefined;
  const trimmed = String(cwd).trim();
  if (!trimmed) return undefined;
  // Inside an asar bundle: ripgrep can't see its real contents, and even if
  // it could, scanning the install dir is never what the user asked for.
  if (trimmed.includes('.asar')) return undefined;
  if (process.platform === 'win32') {
    if (/^[A-Za-z]:$/.test(trimmed)) return undefined; // "C:" without a path
  }
  try {
    const stat = statSync(trimmed);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}
