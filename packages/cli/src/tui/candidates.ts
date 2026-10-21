/**
 * packages/cli/src/tui/candidates.ts
 *
 * Where `duya chat`'s `@` candidates come from: the workspace walk.
 *
 * ## Why this is not imported from `packages/agent`
 *
 * The legacy CLI has an equivalent module
 * (`packages/agent/src/cli/ui/candidates.ts`), and copying it was the cheaper
 * move. It was also the wrong one: `@duya/cli` does not depend on
 * `@duya/agent`, and `packages/agent` is the legacy shell awaiting retirement
 * (gate still open — `scripts/architecture/agent-retirement-gate.mjs`).
 * Reaching into it from the surface that is meant to outlive it would add the
 * one dependency the retirement is trying to remove. The walk itself is pure
 * `node:fs`, so it moves rather than being adapted.
 *
 * What does NOT move is everything that depends on the legacy runtime:
 * `skillItems()` (SkillRegistry) and `modeItems()` (modeModifierRegistry) have
 * no counterpart here, so `context` stays empty and `@` offers paths only.
 *
 * ## What `@` means on this surface
 *
 * A completed path is inserted as TEXT (`@src/app/useApp.ts`), not as a
 * structured attachment: `StartAgentRunInput` carries `prompt: string` and
 * nothing else, so there is nowhere for an attachment to go without a protocol
 * change. That is not a silent half-feature — the model has file tools and a
 * workspace root, so a path in the prompt is a reference it can resolve — but
 * it is also not the desktop's attachment, and it must not be described as one.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PopoverItem } from '@duya/input-completion';

/**
 * Directories never walked.
 *
 * `node_modules` and `.git` are the two that matter for volume. `dist` and
 * `build` are here because a source tree has far more build output than source,
 * and completing into `dist/` is never what a user meant.
 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'release',
  '__pycache__',
]);

/** Directories below the workspace root still worth descending into. */
const MAX_WALK_DEPTH = 8;

/**
 * Hard cap on returned paths.
 *
 * The filter scores the whole list per keystroke, so this is the bound that
 * keeps typing latency flat in a monorepo. The user narrows by typing, which is
 * the intended way past the cap.
 */
const MAX_FILE_CANDIDATES = 800;

/** How long a walk stays fresh. See {@link createFileCompletionSource}. */
const FILE_CACHE_TTL_MS = 2_000;

/**
 * Walk the workspace for candidate file paths.
 *
 * Returns workspace-relative, forward-slash paths — the same shape a user types
 * and the same shape `resolveItemSelection` inserts (which prefixes `@`), so a
 * path never round-trips through a Windows separator into the prompt.
 *
 * `limit` is honoured as an early exit rather than a post-slice: the walk
 * descends breadth-first and stops the moment it has enough, so a shallow
 * directory of candidates is not paid for with a full-tree scan.
 */
export function fileItems(root: string, limit = MAX_FILE_CANDIDATES): PopoverItem[] {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && found.length < limit) {
    const next = queue.shift();
    if (next === undefined) break;

    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is a reason to skip it, never a reason to fail
      // completion: the user did not ask about permissions.
      continue;
    }

    for (const entry of entries) {
      if (found.length >= limit) break;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        if (next.depth + 1 > MAX_WALK_DEPTH) continue;
        queue.push({ dir: join(next.dir, name), depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = relativePath(root, join(next.dir, name));
      if (rel === '') continue;
      found.push(rel);
    }
  }

  return found.map((rel) => ({
    label: rel,
    // The inserted text is the path itself, so `@` + value reproduces it.
    value: rel,
    description: '',
    kind: 'file' as const,
    category: 'context' as const,
    group: 'attachments' as const,
  }));
}

/**
 * Workspace-relative, forward-slash.
 *
 * Returns `''` when `target` IS the root, which is the caller's signal to skip
 * the entry rather than insert the bare root.
 */
export function relativePath(root: string, target: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const normalizedTarget = target.replace(/\\/g, '/');
  if (!normalizedTarget.startsWith(normalizedRoot)) return normalizedTarget.replace(/^.*[\\/]/, '');
  return normalizedTarget.slice(normalizedRoot.length + 1);
}

export interface FileCompletionSource {
  /** Candidates for the current workspace, re-walking at most once per TTL. */
  list(): PopoverItem[];
  /** Drop the cache so the next `list()` re-walks. */
  invalidate(): void;
}

/**
 * A cached `@` file source.
 *
 * The walk is the expensive candidate source and it is read on every keystroke
 * that has `@` open, so it is cached — but only briefly. The legacy CLI cached
 * it for the life of the session, which is right for a one-shot command and
 * wrong for `duya chat`, where a session can outlive dozens of `git checkout`s
 * and file creations; a stale list silently offers paths that no longer exist
 * and hides ones that do. Two seconds is well past a burst of keystrokes and
 * well short of the time it takes to create a file.
 *
 * `now` is injectable so the TTL is an assertion rather than a `sleep`.
 */
export function createFileCompletionSource(
  root: string,
  options: { readonly ttlMs?: number; readonly now?: () => number; readonly limit?: number } = {},
): FileCompletionSource {
  const ttlMs = options.ttlMs ?? FILE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: PopoverItem[] | null = null;
  let walkedAt = Number.NEGATIVE_INFINITY;

  return {
    list(): PopoverItem[] {
      if (cached === null || now() - walkedAt >= ttlMs) {
        cached = fileItems(root, options.limit);
        walkedAt = now();
      }
      return cached;
    },
    invalidate(): void {
      cached = null;
      walkedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
