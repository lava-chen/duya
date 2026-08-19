/**
 * ipc/hooks-handlers.ts - Hook overview IPC handlers
 *
 * Read-only surface for the Settings → Hooks page. Aggregates everything the
 * agent will actually load so the user can see at a glance what is wired up:
 *
 * - **builtin**: the first-party loop steering policies (plan 426) that are
 *   always registered per run unless disabled in `[steering]`.
 * - **configured**: hook.json files referenced by the `[hooks] files` array
 *   of `~/.duya/config.toml` (plan 87 vocabulary) — the same ecosystem
 *   shape as Claude Code settings.json / ZCode plugin hooks.json. The agent
 *   validates each file with `HooksSettingsSchema` before running; this
 *   handler mirrors the shape for display only.
 *
 * This handler does NOT mutate anything — it is a pure projection for display.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain } from 'electron';
import { getConfigStore } from '../config/store-instance';
import { resolveConfigTomlPath } from '../config';
import { getLogger, LogComponent } from '../logging/logger';

/** Result row for one loaded hook. */
export interface HookRow {
  name: string;
  command: string;
  source: string;
  kind: 'builtin' | 'config';
  matcher?: string;
}

/** One HookRow per event, so the UI can group by trigger time. */
export interface HookEventGroup {
  event: string;
  hooks: HookRow[];
}

export interface HookOverview {
  configPath: string;
  events: HookEventGroup[];
}

// ============================================================================
// Builtin loop hooks (plan 426). These are in-process steering policies — they
// carry no external command, so the "command" column shows what they do.
// ============================================================================

interface BuiltinHookMeta {
  id: string;
  events: string[];
  command: string;
}

const BUILTIN_LOOP_HOOKS: BuiltinHookMeta[] = [
  {
    id: 'builtin.premature-stop',
    events: ['PreFinalize'],
    command:
      'Goal premature-stop guard: veto finalize and nudge to continue when the model bails while a goal is still active.',
  },
  {
    id: 'builtin.tool-intent',
    events: ['PreFinalize'],
    command:
      'Tool-intent guard: veto finalize when the model announced an action but emitted no tool_use (capped per run).',
  },
  {
    id: 'builtin.todo-gate',
    events: ['PreFinalize'],
    command:
      'Todo gate: veto finalize while pending/in-progress tasks remain (fires once per run).',
  },
  {
    id: 'builtin.dead-loop-nudge',
    events: ['PostToolUse'],
    command:
      'Dead-loop nudge: inject a change-approach reminder at consecutive identical tool-call thresholds.',
  },
];

const COMMAND_TYPE_LABELS: Record<string, string> = {
  command: 'Shell Command',
  process: 'Process',
  http: 'HTTP',
  prompt: 'Prompt',
  agent: 'Agent',
};

/** A configured hook list item — the plan-87 `{ type, command }` shape. */
type ConfigHookEntry = {
  type?: string;
  command?: string;
  url?: string;
  prompt?: string;
  args?: string[];
  [key: string]: unknown;
};

/** A configured matcher group: `{ matcher?, hooks: [...] }`. */
type ConfigMatcher = {
  matcher?: string;
  hooks?: ConfigHookEntry[];
};

/**
 * Build the display-name for a configured hook. Plan-87 hooks are anonymous,
 * so we derive one from its type (plus matcher context when a group has only
 * one hook).
 */
function configHookName(hook: ConfigHookEntry, groupSize: number): string {
  const type = hook.type ?? 'unknown';
  const label = COMMAND_TYPE_LABELS[type] ?? type;
  return groupSize > 1 ? `${label} ${groupSize}` : label;
}

/** Readable "command" for a configured hook across its discriminated variants. */
function configHookCommand(hook: ConfigHookEntry): string {
  switch (hook.type) {
    case 'command':
      return typeof hook.command === 'string' ? hook.command : '';
    case 'process':
      return `${hook.command ?? ''} ${(hook.args ?? []).join(' ')}`.trim();
    case 'http':
      return typeof hook.url === 'string' ? hook.url : '';
    case 'prompt':
    case 'agent':
      return typeof hook.prompt === 'string' ? hook.prompt : '';
    default:
      return '';
  }
}

/**
 * Project the `[hooks] files` config (raw from the ConfigStore snapshot — the
 * agent parses each referenced hook.json separately) into per-event rows.
 * The file shape mirrors the agent's `HooksSettingsSchema` (event → matcher
 * groups → hook commands) under a top-level `hooks` key, with an optional
 * `description`. Unknown / malformed entries are skipped (the agent ignores
 * them too); unreadable files surface as a single row so the user sees the
 * broken path in the UI.
 */
function configuredRows(raw: unknown): HookEventGroup[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const files = (raw as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

  const groups: HookEventGroup[] = [];
  const byEvent = new Map<string, HookRow[]>();
  for (const entry of files) {
    if (typeof entry !== 'string') continue;
    const filePath = resolveHookDisplayPath(entry);
    const body = readHookFile(filePath);
    if (body === undefined) {
      // Unreadable hook file — surface the broken path so the user can fix it.
      pushRow(byEvent, 'Setup', {
        kind: 'config',
        name: 'Hook file not readable',
        command: entry,
        source: filePath,
      });
      continue;
    }
    const hooksObj = parseHookFileBody(body);
    if (hooksObj === undefined) {
      pushRow(byEvent, 'Setup', {
        kind: 'config',
        name: 'Hook file invalid',
        command: entry,
        source: filePath,
      });
      continue;
    }
    for (const [event, matchers] of Object.entries(hooksObj)) {
      if (!Array.isArray(matchers)) continue;
      const rows: HookRow[] = [];
      for (const matcherRaw of matchers) {
        if (matcherRaw === null || typeof matcherRaw !== 'object') continue;
        const matcher = matcherRaw as ConfigMatcher;
        const hooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];
        hooks.forEach((hook, idx) => {
          if (hook === null || typeof hook !== 'object') return;
          rows.push({
            kind: 'config',
            name: configHookName(hook, hooks.length),
            command: configHookCommand(hook),
            matcher: matcher.matcher,
            source: filePath,
          });
        });
      }
      if (rows.length > 0) pushRows(byEvent, event, rows);
    }
  }
  for (const [event, rows] of byEvent) {
    groups.push({ event, hooks: rows });
  }
  return groups;
}

/** Expand `~` and resolve a hook.json path for display (relative → config root). */
function resolveHookDisplayPath(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  if (path.isAbsolute(entry)) return entry;
  const configRoot = path.dirname(resolveConfigTomlPath());
  return path.resolve(configRoot, entry);
}

/** Read a hook.json body; undefined when missing/unreadable. */
function readHookFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Parse the `hooks` object of a hook.json; undefined when invalid. */
function parseHookFileBody(body: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(body);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
    const hooks = (doc as { hooks?: unknown }).hooks;
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined;
    return hooks as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function pushRow(
  byEvent: Map<string, HookRow[]>,
  event: string,
  row: HookRow,
): void {
  const rows = byEvent.get(event) ?? [];
  rows.push(row);
  byEvent.set(event, rows);
}

function pushRows(
  byEvent: Map<string, HookRow[]>,
  event: string,
  rows: HookRow[],
): void {
  byEvent.set(event, [...(byEvent.get(event) ?? []), ...rows]);
}

/** Render builtin rows for a given event. */
function builtinRowsForEvent(event: string): HookRow[] {
  return BUILTIN_LOOP_HOOKS.filter((h) => h.events.includes(event)).map((h) => ({
    kind: 'builtin',
    name: h.id.replace(/^builtin\./, ''),
    command: h.command,
    source: 'builtin',
  }));
}

/** Canonical display order for events (loop events first, then the rest A–Z). */
const LOOP_FIRST_ORDER = ['PreTurn', 'PostToolUse', 'PreFinalize', 'PostTurn'];
const FALLBACK_EVENT_ORDER = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUseFailure', 'Stop', 'StopFailure', 'PermissionDenied',
  'PermissionRequest', 'Notification', 'Elicitation', 'ElicitationResult',
  'Setup', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'CwdChanged',
  'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact',
  'PostCompact', 'TaskCreated', 'TaskCompleted', 'ConfigChange',
  'InstructionsLoaded',
];

function sortEventGroups(configured: HookEventGroup[]): HookEventGroup[] {
  const configuredByEvent = new Map(configured.map((g) => [g.event, g.hooks]));
  // Events that host builtin loop hooks must always surface, even when the
  // user has not configured anything under `[hooks]`.
  const builtinEvents = new Set<string>();
  for (const h of BUILTIN_LOOP_HOOKS) {
    for (const e of h.events) builtinEvents.add(e);
  }
  const events = new Set<string>([...configuredByEvent.keys(), ...builtinEvents]);

  const groups: HookEventGroup[] = [];
  for (const event of LOOP_FIRST_ORDER) {
    if (!events.has(event)) continue;
    groups.push({ event, hooks: [...builtinRowsForEvent(event), ...(configuredByEvent.get(event) ?? [])] });
    events.delete(event);
  }
  for (const event of FALLBACK_EVENT_ORDER) {
    if (!events.has(event)) continue;
    const configRows = configuredByEvent.get(event) ?? [];
    if (configRows.length === 0) continue;
    groups.push({ event, hooks: configRows });
    events.delete(event);
  }
  // Any remaining events surface in alphabetical order.
  for (const event of [...events].sort()) {
    groups.push({ event, hooks: configuredByEvent.get(event) ?? [] });
  }
  return groups;
}

export function registerHooksHandlers(): void {
  ipcMain.handle('hooks:overview', async (): Promise<HookOverview> => {
    try {
      const raw = getConfigStore().getByPath('hooks');
      return {
        configPath: resolveConfigTomlPath(),
        events: sortEventGroups(configuredRows(raw)),
      };
    } catch (err) {
      const logger = getLogger();
      logger.error(
        'hooks:overview failed',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        LogComponent.Settings,
      );
      return { configPath: resolveConfigTomlPath(), events: [] };
    }
  });
}