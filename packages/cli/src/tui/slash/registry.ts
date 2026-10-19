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
  describeSpec,
  formatSpecLabel,
  specsForSurface,
  type CommandSpec,
} from '@duya/command-catalog';
import type { TuiSlashCommandDef, TuiSlashGroup } from './types.js';
import { SESSION_INFO_COMMANDS } from './session-info.js';
import { SESSION_OPS_COMMANDS } from './session-ops.js';
import { MODEL_COMMANDS } from './model.js';
import { EFFORT_COMMANDS } from './effort.js';
import { SETTINGS_COMMANDS } from './settings.js';
import { EXPORT_COMMANDS } from './export.js';
import { CAPABILITIES_COMMANDS } from './capabilities.js';
import { READ_FILE_COMMANDS } from './read-file.js';
import { HOTKEYS_COMMANDS } from './hotkeys.js';

/** Every command this surface can actually run. */
export const TUI_SLASH_COMMANDS: readonly TuiSlashCommandDef[] = [
  ...MODEL_COMMANDS,
  ...EFFORT_COMMANDS,
  ...SETTINGS_COMMANDS,
  ...HOTKEYS_COMMANDS,
  ...SESSION_INFO_COMMANDS,
  ...SESSION_OPS_COMMANDS,
  ...EXPORT_COMMANDS,
  ...CAPABILITIES_COMMANDS,
  ...READ_FILE_COMMANDS,
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
 */
export function advertisedSpecs(options: { readonly busy?: boolean } = {}): readonly CommandSpec[] {
  return specsForSurface('cli', { busy: options.busy ?? false })
    .filter((spec) => BY_NAME.has(spec.name));
}

/** Rows for the `/` completion popup. */
export function buildSlashCompletionRows(options: { readonly busy?: boolean } = {}): PopoverItem[] {
  return advertisedSpecs(options).map((spec) => ({
    label: `/${spec.name}`,
    value: `/${spec.name}`,
    description: describeSpec(spec),
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
export function buildSlashHelpSections(): ReadonlyArray<{
  readonly title: string;
  readonly lines: readonly string[];
}> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const group of GROUP_ORDER) {
    const commands = TUI_SLASH_COMMANDS.filter((command) => command.group === group);
    if (commands.length === 0) continue;
    const specs = commands
      .map((command) => specsForSurface('cli').find((spec) => spec.name === command.name))
      .filter((spec): spec is CommandSpec => spec !== undefined);
    const labels = specs.map((spec) => formatSpecLabel(spec));
    const width = Math.max(...labels.map((label) => label.length));
    sections.push({
      title: group,
      lines: labels.map((label, index) => `  ${label.padEnd(width)}  ${describeSpec(specs[index] as CommandSpec)}`),
    });
  }
  return sections;
}
