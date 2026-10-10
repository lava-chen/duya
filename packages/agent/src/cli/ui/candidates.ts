/**
 * Where the CLI's completion candidates come from.
 *
 * ## Why this is a separate module from the shared contract
 *
 * `@duya/input-completion` decides WHEN a popup opens and WHAT accepting writes
 * back. It deliberately holds no candidate sources, because the two surfaces
 * have genuinely different ones: the desktop reads skills over Electron IPC
 * and plugins from its own registry, the CLI reads `packages/agent` in process.
 * Sharing the rules and sharing the data are different decisions, and only the
 * first one is a contract.
 *
 * ## What each surface has that the other does not
 *
 * - **slash commands** — the CLI registry (`./slash-commands.js`) is its own,
 *   unrelated to the desktop's. This is CLI data.
 * - **skills** — `SkillRegistry`, in process, already filtered by
 *   `listUserInvocable()` so a model-only skill cannot be typed by a human.
 * - **modes** — `modeModifierRegistry` (plan 224). The desktop has modes too,
 *   from a store rather than a registry.
 * - **files** — a bounded workspace walk. NEITHER surface has this today; the
 *   desktop's `@` list is attachments/plugins/modes only, so this is net-new on
 *   the CLI and the matching desktop work is its own change.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PopoverItem } from '@duya/input-completion';
import { getSlashCommands, isCommandAvailable } from '../slash-commands.js';
import { getSkillRegistry } from '../../skills/index.js';
import { modeModifierRegistry } from '../../modes/registry.js';

/**
 * Directories never walked.
 *
 * `node_modules` and `.git` are the two that matter for volume. `dist` and
 * `build` are here because a source tree has far more build output than source,
 * and completing into `dist/` is never what a user meant. The rest are the
 * usual generated trees.
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
 * A cap rather than a "return everything" because the filter runs over the whole
 * list: a monorepo root can hold hundreds of thousands of entries, and scoring
 * them per keystroke is the difference between instant and visibly laggy. The
 * user narrows the list by typing, which is the intended way past the cap.
 */
const MAX_FILE_CANDIDATES = 800;

/** `/` candidates: the CLI command registry, filtered to what CLI can run. */
export function slashCommandItems(): PopoverItem[] {
  return getSlashCommands()
    .filter((cmd) => isCommandAvailable(cmd, 'cli'))
    .map((cmd) => ({
      label: `/${cmd.name}`,
      value: `/${cmd.name}`,
      description: cmd.description,
      kind: 'slash_command' as const,
      category: 'command' as const,
      group: 'settings' as const,
    }));
}

/**
 * `/` candidates: user-invocable skills.
 *
 * `listUserInvocable()` rather than `list()`: a skill the model may invoke but
 * the human may not is not something a completion popup should offer, and
 * inserting one would produce a slash command with no handler behind it.
 */
export function skillItems(): PopoverItem[] {
  return getSkillRegistry()
    .listUserInvocable()
    .map((skill) => ({
      label: `/${skill.name}`,
      value: `/${skill.name}`,
      description: skill.description,
      kind: 'agent_skill' as const,
      category: 'command' as const,
      group: 'skills' as const,
    }));
}

/**
 * `@` candidates: the product modes.
 *
 * These are the CLI's counterpart to the desktop's mode items, which is why the
 * desktop can offer modes under `@` today and this surface could not.
 */
export function modeItems(): PopoverItem[] {
  return modeModifierRegistry.list().map((mode) => ({
    // The label is `display.label`, not the id: a mode registers as
    // `plan-task` but presents as whatever the author chose. The id is the
    // VALUE because that is what the runtime switches on.
    label: `@${mode.display?.label ?? mode.id}`,
    value: mode.id,
    description: mode.display?.description ?? '',
    kind: 'mode' as const,
    modeValue: mode.id,
    category: 'context' as const,
    group: 'mode' as const,
  }));
}

/** Everything `@` can offer that is not a file path. */
export function contextItems(): PopoverItem[] {
  return modeItems();
}

/**
 * The real CLI sources, wired once.
 *
 * The file walk is the expensive one, so it is computed LAZILY and then cached
 * for the life of the session: a workspace does not change under a running
 * prompt, and re-walking on every keystroke is the difference between instant
 * and visibly laggy.
 */
export function defaultCompletionSources(workspace: string): CompletionSourcesLike {
  let files: PopoverItem[] | null = null;
  return {
    slash: () => [...slashCommandItems(), ...skillItems()],
    context: () => contextItems(),
    files: () => {
      if (files === null) files = fileItems(workspace);
      return files;
    },
  };
}

/** The shape `defaultCompletionSources` returns, without importing the controller. */
interface CompletionSourcesLike {
  slash: () => PopoverItem[];
  context: () => PopoverItem[];
  files: () => PopoverItem[];
}

/**
 * Walk the workspace for candidate file paths.
 *
 * Returns workspace-relative, forward-slash paths — the same shape a user types
 * and the same shape inserted by `resolveItemSelection`, so a path never
 * round-trips through a Windows separator into the prompt.
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
    kind: 'agent_skill' as const,
    category: 'context' as const,
    group: 'attachments' as const,
  }));
}

/**
 * Workspace-relative, forward-slash.
 *
 * Exported because the separator normalisation is the part worth asserting: a
 * path that round-trips through a Windows separator into the prompt is a bug
 * the user sees as a file that does not exist.
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
