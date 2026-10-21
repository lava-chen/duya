/**
 * Goal repo-changes serialization (grok repo_changes/, duya-ized light).
 *
 * grok archives the full worktree to a blob store; duya needs only the
 * *diff surface* a verifier can act on. This module captures, from the
 * goal's baseline commit:
 *
 *   - `git diff --stat <baseline>` — which files changed and by how much;
 *   - `git diff <baseline> -- <changed paths>` — the actual patch, bounded.
 *
 * The serialized diff is inlined into the verifier prompt so a skeptic
 * judges what the model ACTUALLY changed (grok's `changes_baseline_commit`
 * + repo changes), not just the model's summary. Bounded at
 * `MAX_DIFF_BYTES` so a runaway diff cannot blow up the context; a
 * truncated diff keeps the stat line + a truncation marker so the skeptic
 * knows the patch is partial.
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';

/** Cap on the serialized diff body (bytes). */
export const MAX_DIFF_BYTES = 12 * 1024;

/** git command timeout (ms). */
const GIT_TIMEOUT_MS = 10_000;

function runGit(cwd: string, args: string[], maxBuffer: number): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
  });
}

/**
 * Capture `git rev-parse HEAD` at goal start (grok
 * `changes_baseline_commit`). Best-effort: undefined when git is
 * unavailable or not a repo — verifiers then omit the diff section.
 */
export function captureBaselineCommit(workingDirectory: string): string | undefined {
  if (!workingDirectory) return undefined;
  const result = runGit(workingDirectory, ['rev-parse', 'HEAD'], 4096);
  const out = result.stdout;
  if (result.error || typeof out !== 'string') return undefined;
  const commit = out.trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit : undefined;
}

/**
 * Serialize the working-tree changes against `baselineCommit` in the
 * given working directory. Returns undefined when git is unavailable /
 * not a repo / no baseline. The result is a bounded, model-friendly diff
 * summary: stat line + patch (or truncation marker).
 */
export function serializeRepoChanges(
  workingDirectory: string,
  baselineCommit: string,
): string | undefined {
  if (!workingDirectory || !baselineCommit) return undefined;

  // `--no-ext-diff` keeps output deterministic; `--binary` not needed —
  // binary files just show as "Binary files differ" and are dropped from
  // the patch body.
  const statResult = runGit(workingDirectory, ['diff', '--no-ext-diff', '--stat', baselineCommit], MAX_DIFF_BYTES);
  const stat = statResult.stdout;
  if (statResult.error || typeof stat !== 'string' || !stat.trim()) {
    // No changes, or git failed — nothing to show.
    return undefined;
  }

  // Collect changed paths (excluding deletions) to bound the patch body.
  const nameResult = runGit(workingDirectory, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=ACMRT', baselineCommit], MAX_DIFF_BYTES);
  const names = (nameResult.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const parts: string[] = [];
  parts.push('## Changed files (vs baseline)');
  parts.push(stat.trim());
  parts.push('');

  if (names.length > 0) {
    // Bound the patch: git itself caps per-file output; we cap the whole.
    const patchResult = runGit(
      workingDirectory,
      ['diff', '--no-ext-diff', '--no-color', baselineCommit, '--', ...names],
      MAX_DIFF_BYTES + 64 * 1024, // headroom so ENOBUFS only trips on genuinely huge diffs
    );
    const patch = patchResult.stdout;
    if (typeof patch === 'string' && patch.trim()) {
      parts.push('## Diff (bounded)');
      if (patch.length > MAX_DIFF_BYTES) {
        parts.push(patch.slice(0, MAX_DIFF_BYTES));
        parts.push('');
        parts.push('(diff truncated — see the stat above for the full change surface)');
      } else {
        parts.push(patch);
      }
    }
  }

  return parts.join('\n');
}
