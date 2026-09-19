/**
 * safe-rm — recoverable deletion for top-level `rm` commands (plan 554).
 *
 * minimax parity: the model's plain `rm` invocations are routed to the OS
 * Recycle Bin instead of an irreversible unlink, so an over-eager deletion
 * stays recoverable. Interception is deliberately CONSERVATIVE — only a
 * command that is exactly `rm [flags] <paths...>` qualifies:
 *   - `rm` must be the FIRST token (not `x && rm ...`, not `echo rm`);
 *   - no shell operators anywhere (`&& || ; | & > < backticks $()` or
 *     newlines) — compound commands fall through to the normal shell path;
 *   - no glob metacharacters in the paths (`*?[`) — the Recycle Bin API
 *     does not expand patterns, and half-interpreting them would delete
 *     the wrong thing;
 *   - Windows only (the primary duya platform). Other platforms keep the
 *     normal `rm`.
 *
 * Flags are consumed and ignored: `rm -rf` and `rm -r -f` both recycle
 * recursively by nature of the Recycle Bin API.
 */

import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { expandPath } from '../../utils/path.js';

/** Characters whose presence means "not a plain rm" — compound/redirect. */
const SHELL_OPERATOR_PATTERN = /[;&|><`$\n\r]/;

export interface PlainRm {
  targets: string[];
}

/**
 * Parse a shell command into a plain-`rm` target list. Returns null when
 * the command is anything other than a simple top-level `rm` — the caller
 * then runs it through the shell unchanged.
 */
export function parsePlainRmCommand(command: string): PlainRm | null {
  const trimmed = (command ?? '').trim();
  if (!trimmed) return null;

  // Quote-aware tokenizer (single/double quotes hold paths with spaces).
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) return null; // unterminated quote — not a plain rm
  if (current) tokens.push(current);

  if (tokens[0] !== 'rm') return null;
  // Shell operators ANYWHERE (even inside the rm argv) mean the command's
  // effect is no longer "delete these paths" — fall through to the shell.
  if (SHELL_OPERATOR_PATTERN.test(trimmed)) return null;

  const targets: string[] = [];
  let sawSeparator = false;
  for (const token of tokens.slice(1)) {
    if (!sawSeparator && token === '--') {
      sawSeparator = true;
      continue;
    }
    if (!sawSeparator && token.startsWith('-')) continue; // flags (rm -rf …)
    // Glob patterns cannot be recycled literally — the Recycle Bin API has
    // no expansion, so a globbed rm keeps its normal shell semantics.
    if (/[*?[]/.test(token)) return null;
    targets.push(token);
  }
  if (targets.length === 0) return null;
  return { targets };
}

/**
 * Build the PowerShell script that recycles the resolved absolute paths.
 * One guarded statement per path: files use DeleteFile, directories use
 * DeleteDirectory, missing paths emit a MISSING marker instead of failing
 * the whole batch. Paths are single-quoted (escape `'` by doubling).
 */
export function buildRecycleScript(paths: readonly string[]): string {
  const statements = paths.map((p) => {
    const quoted = `'${p.replace(/'/g, "''")}'`;
    return [
      `if (Test-Path -LiteralPath ${quoted} -PathType Leaf) {`,
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${quoted},'OnlyErrorDialogs','SendToRecycleBin');`,
      `Write-Output ('TRASHED:' + ${quoted})`,
      `} elseif (Test-Path -LiteralPath ${quoted} -PathType Container) {`,
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${quoted},'OnlyErrorDialogs','SendToRecycleBin');`,
      `Write-Output ('TRASHED:' + ${quoted})`,
      `} else {`,
      `Write-Output ('MISSING:' + ${quoted})`,
      `}`,
    ].join(' ');
  });
  return (
    `Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null; ` + statements.join(' ')
  );
}

export interface RecycleOutcome {
  /** Absolute paths confirmed moved to the Recycle Bin. */
  trashed: string[];
  /** Paths reported missing (nothing to delete — reported, not an error). */
  missing: string[];
  /** Paths that could not be recycled, with the reason. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Recycle the given rm targets (resolved against `cwd`). Never throws —
 * per-path failures come back in `failed` so the tool result can show
 * exactly what happened.
 */
export async function moveToRecycleBin(
  targets: readonly string[],
  cwd: string,
): Promise<RecycleOutcome> {
  const outcome: RecycleOutcome = { trashed: [], missing: [], failed: [] };
  if (targets.length === 0) return outcome;

  const resolved: string[] = [];
  for (const target of targets) {
    try {
      const expanded = expandPath(target, cwd || undefined);
      resolved.push(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
    } catch {
      outcome.failed.push({ path: target, error: 'unresolvable path' });
    }
  }
  if (resolved.length === 0) return outcome;

  const script = buildRecycleScript(resolved);
  const stdout = await new Promise<string>((resolvePromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdoutResult, stderrResult) => {
        if (error && !stdoutResult) {
          // The batch died before producing markers — attribute to every path.
          const reason =
            (typeof stderrResult === 'string' && stderrResult.trim()) ||
            (error instanceof Error ? error.message : 'powershell failed');
          for (const p of resolved) outcome.failed.push({ path: p, error: reason });
          resolvePromise('');
          return;
        }
        if (error && stderrResult) {
          // Partial output may still exist; the marker parse below decides.
          void stderrResult;
        }
        resolvePromise(typeof stdoutResult === 'string' ? stdoutResult : '');
      },
    );
  });

  const reported = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('TRASHED:')) {
      const p = trimmed.slice('TRASHED:'.length).trim();
      outcome.trashed.push(p);
      reported.add(p);
    } else if (trimmed.startsWith('MISSING:')) {
      const p = trimmed.slice('MISSING:'.length).trim();
      outcome.missing.push(p);
      reported.add(p);
    }
  }
  for (const p of resolved) {
    if (!reported.has(p)) {
      outcome.failed.push({ path: p, error: 'recycle operation produced no confirmation' });
    }
  }
  return outcome;
}
