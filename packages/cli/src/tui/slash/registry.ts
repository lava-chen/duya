/**
 * packages/cli/src/tui/slash/registry.ts
 *
 * The CLI's command table: which specs this surface can RUN, and the popup /
 * `/help` views derived from the shared catalog.
 *
 * ## Division of labour
 *
 * `@duya/command-catalog` owns the definition (name, aliases, description,
 * argument shape, which surfaces advertise it). This file owns the behaviour.
 * The split is deliberate and mirrors codex: its `slash_command.rs` holds the
 * definition and its `description()`; `slash_dispatch.rs` holds the behavior.
 * An executor cannot be shared across the process boundary — the Desktop's
 * talks to a renderer bridge, this one talks to the Host over HTTP — and
 * pretending otherwise would couple two very different transports.
 *
 * ## The lookup/filter separation (the rule that keeps commands alive)
 *
 * {@link resolveTuiSlashCommand} answers "can this surface RUN it", from the
 * handler table below. {@link advertisedSpecs} answers "should the popup SHOW
 * it", from the shared catalog. A command the CLI can run but chose not to
 * advertise still resolves when typed — "not advertised" must never silently
 * become "unknown command".
 */

import type { PopoverItem } from '@duya/input-completion';
import {
  availableSpecsFor,
  describeSpec,
  findSpec,
  formatSpecLabel,
  type CommandLocale,
  type CommandSpec,
} from '@duya/command-catalog';
import type { TuiSlashCommandDef, TuiSlashGroup } from './types.js';
import { SESSION_INFO_COMMANDS } from './session-info.js';
import { SESSION_OPS_COMMANDS } from './session-ops.js';
import { PROJECT_COMMANDS } from './project.js';
import { APPS_COMMANDS } from './apps.js';
import { PLUGIN_COMMANDS } from './plugin.js';
import { WORKFLOW_COMMANDS } from './workflow.js';
import { APP_COMMANDS } from './app.js';
import { CHECKOUT_COMMANDS } from './checkout.js';
import { WORKTREE_COMMANDS } from './worktree.js';
import { PR_COMMANDS } from './pr.js';
import { MODEL_COMMANDS } from './model.js';
import { EFFORT_COMMANDS } from './effort.js';
import { SETTINGS_COMMANDS } from './settings.js';
import { EXPORT_COMMANDS } from './export.js';
import { CAPABILITIES_COMMANDS } from './capabilities.js';
import { DOCTOR_COMMANDS } from './doctor.js';
import { INIT_COMMANDS } from './init.js';
import { READ_FILE_COMMANDS } from './read-file.js';
import { HOTKEYS_COMMANDS } from './hotkeys.js';
import { DIFF_COMMANDS } from './diff.js';
import { COMPACT_COMMANDS } from './compact.js';
import { BTW_COMMANDS } from './btw.js';
import { MCP_COMMANDS } from './mcp.js';
import { SKILLS_COMMANDS } from './skills.js';
import { TASKS_COMMANDS } from './tasks.js';

/** Every command this surface can actually run. */
export const TUI_SLASH_COMMANDS: readonly TuiSlashCommandDef[] = [
  ...MODEL_COMMANDS,
  ...EFFORT_COMMANDS,
  ...SETTINGS_COMMANDS,
  ...HOTKEYS_COMMANDS,
  ...SESSION_INFO_COMMANDS,
  ...APPS_COMMANDS,
  ...PLUGIN_COMMANDS,
  ...WORKFLOW_COMMANDS,
  ...SESSION_OPS_COMMANDS,
  ...PROJECT_COMMANDS,
  ...APP_COMMANDS,
  ...CHECKOUT_COMMANDS,
  ...WORKTREE_COMMANDS,
  ...PR_COMMANDS,
  ...EXPORT_COMMANDS,
  ...CAPABILITIES_COMMANDS,
  ...DOCTOR_COMMANDS,
  ...INIT_COMMANDS,
  ...READ_FILE_COMMANDS,
  ...DIFF_COMMANDS,
  ...COMPACT_COMMANDS,
  ...BTW_COMMANDS,
  ...MCP_COMMANDS,
  ...SKILLS_COMMANDS,
  ...TASKS_COMMANDS,
];

const BY_NAME = new Map<string, TuiSlashCommandDef>();
for (const command of TUI_SLASH_COMMANDS) {
  BY_NAME.set(command.name, command);
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command);
}

/** Can the CLI RUN this token? Unfiltered by what the popup advertises. */
export function resolveTuiSlashCommand(name: string): TuiSlashCommandDef | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

export function hasTuiSlashCommand(name: string): boolean {
  return resolveTuiSlashCommand(name) !== undefined;
}

/**
 * What the popup and `/help` advertise: the shared catalog's CLI view,
 * intersected with what this surface can actually run.
 *
 * The intersection is the important half. A catalog entry with no handler
 * here would otherwise be advertised and then answer "unknown command" — the
 * exact failure mode the catalog's own integrity tests guard against, checked
 * once at startup instead of once per keystroke by the user.
 *
 * The catalog decides availability from the same two facts the handlers read
 * (`ctx.busy`, and whether there is a session), so the popup never offers a
 * command the handler is about to refuse.
 */
export function advertisedSpecs(options: { readonly busy?: boolean } = {}): readonly CommandSpec[] {
  return availableSpecsFor('cli', {
    hasSession: true,
    busy: options.busy ?? false,
  }).filter((spec) => BY_NAME.has(spec.name));
}

/** Rows for the `/` completion popup. */
export function buildSlashCompletionRows(options: {
  readonly busy?: boolean;
  readonly locale?: CommandLocale;
} = {}): PopoverItem[] {
  return advertisedSpecs(options).map((spec) => ({
    label: `/${spec.name}`,
    value: `/${spec.name}`,
    description: describeSpec(spec, options.locale),
    kind: 'slash_command' as const,
    category: 'command' as const,
    group: 'settings' as const,
  }));
}

/** Group order for `/help`. The catalog's array order is the popup order. */
const GROUP_ORDER: readonly TuiSlashGroup[] = ['Model', 'Settings', 'Session info', 'Session ops', 'Export'];

/**
 * `/help` lines for the commands this surface runs, grouped like the catalog's
 * categories and rendered from the SAME specs the popup uses — so `/help` and
 * the popup cannot list different things.
 */
export function buildSlashHelpSections(locale: CommandLocale = 'zh'): ReadonlyArray<{
  readonly title: string;
  readonly lines: readonly string[];
}> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const group of GROUP_ORDER) {
    const commands = TUI_SLASH_COMMANDS.filter((command) => command.group === group);
    if (commands.length === 0) continue;
    const specs = commands
      .map((command) => findSpec(command.name))
      .filter((spec): spec is CommandSpec => spec !== undefined);
    const labels = specs.map((spec) => formatSpecLabel(spec));
    const width = Math.max(...labels.map((label) => label.length));
    const title = locale === 'zh'
      ? ({
          Model: '模型',
          Settings: '设置',
          'Session info': '会话信息',
          'Session ops': '会话操作',
          Export: '导出',
        } as const)[group]
      : group;
    sections.push({
      title,
      lines: labels.map((label, index) => `  ${label.padEnd(width)}  ${describeSpec(specs[index] as CommandSpec, locale)}`),
    });
  }
  return sections;
}
