/**
 * packages/cli/src/tui/slash/skills.ts
 *
 * `/skills` — the skills this project can use, listed in the terminal.
 *
 * ## Why the CLI asks the Host
 *
 * The Desktop's `/skills` goes through the main process, which asks
 * `@duya/host/skills/skillService` for the winner set. This command used to
 * call that SAME service in process — the CLI has `@duya/host` on its runtime
 * dependencies — and that is precisely what the client-closure gate (G11-1)
 * forbids: the value-import closure of a client entry must not reach
 * `@duya/agent-core`, and the skill service reaches it through
 * `@duya/agent-core/skills/resolver`.
 *
 * So the CLI asks the Host over HTTP instead, the same way `/mcp` asks for
 * the MCP inventory: `GET /v1/skills?sessionId=<id>` answers with the
 * skills AND the session's working directory. The discovery itself stays
 * the Host's — one implementation, so the Desktop's list and the CLI's list
 * cannot disagree about which skill wins a name.
 *
 * ## The session's working directory comes with the answer
 *
 * Project skills live next to the project the session works in, and
 * `process.cwd()` is wherever the user happened to start the CLI — a
 * different fact as soon as the session was resumed from another directory.
 * The Host knows the session's working directory, so it answers with it
 * next to the list; the CLI resolves no path on its own.
 *
 * ## "No skills" and "this Host cannot answer" are different answers
 *
 * A Host without the inventory capability answers 404
 * `skill_inventory_api_unavailable`. That is not "there are no skills" — it is
 * "this Host cannot answer the question", and the two are rendered
 * differently. An empty list is a fact that was observed; a refusal is not,
 * and a panel that said "no skills" for a Host that never answered would
 * report a fact it never observed.
 *
 * ## What a standalone CLI cannot see
 *
 * Plugin-declared skills are NOT in this list, and the list says so — on
 * every panel, including the empty one. A list that is shorter than the
 * Desktop's without this sentence reads as a WRONG list rather than as a
 * smaller surface, which is the one mistake this line exists to prevent.
 */

import { describeError, hostErrorCode, showEntries, showPanel, type TuiViewEntry } from './shared.js';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';

const FOOTER = 'Esc close';

/**
 * The one line that says what this surface cannot see.
 *
 * It is printed with EVERY panel, including the empty one: a list that is
 * shorter than the Desktop's without this sentence reads as a wrong list
 * rather than as a smaller surface.
 */
const PLUGIN_LIMITATION =
  'Plugin skills are not listed: the plugin registry carries no install path and the plugin packages '
  + 'live under the Electron app\'s data directory, so a standalone CLI cannot see them.';

/** One skill, as the Host's inventory route reports it. */
interface HostSkillEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
}

/** The inventory payload: the skills plus the project's working directory. */
interface SkillsInventoryResponse {
  readonly skills: readonly HostSkillEntry[];
  readonly workingDirectory: string;
}

/**
 * Narrow one unknown record into the fields this command shows.
 *
 * The payload arrives over HTTP as JSON, so the declared type describes the
 * happy path and not a guarantee: one malformed entry must not take the
 * whole listing down.
 */
function narrowEntry(value: unknown): HostSkillEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string' || name === '') return undefined;
  const id = record['id'];
  const description = record['description'];
  const source = record['source'];
  return {
    id: typeof id === 'string' && id !== '' ? id : name,
    name,
    description: typeof description === 'string' ? description : '',
    source: typeof source === 'string' ? source : '',
    // An entry that does not say whether it is enabled counts as enabled,
    // and one that does not say whether the user may invoke it counts as
    // invocable: a skill only leaves the list when the Host says so.
    enabled: record['enabled'] !== false,
    userInvocable: record['userInvocable'] !== false,
  };
}

/**
 * The skills in an inventory payload.
 *
 * `undefined` means the payload is not an inventory at all — a different
 * fact from "the inventory is empty", and one the caller has to report
 * differently.
 */
function readInventory(payload: unknown): SkillsInventoryResponse | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const raw = record['skills'];
  if (!Array.isArray(raw)) return undefined;
  const skills: HostSkillEntry[] = [];
  for (const item of raw) {
    const entry = narrowEntry(item);
    if (entry !== undefined) skills.push(entry);
  }
  const workingDirectory = record['workingDirectory'];
  return {
    skills,
    workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : '',
  };
}

/** The table, aligned on the widest cell of each column. */
function renderTable(rows: readonly HostSkillEntry[]): string[] {
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const sourceWidth = Math.max(...rows.map((row) => row.source.length));
  const header = `  ${'name'.padEnd(nameWidth)}  ${'source'.padEnd(sourceWidth)}  invocable  enabled  description`;
  const body = rows.map((row) => {
    const invocable = row.userInvocable ? 'yes' : 'no';
    const enabled = row.enabled ? 'yes' : 'no';
    return `  ${row.name.padEnd(nameWidth)}  ${row.source.padEnd(sourceWidth)}  ${invocable.padEnd(9)}  ${enabled.padEnd(7)}  ${row.description}`;
  });
  return [header, ...body];
}

/** The listing, as panel lines. */
function skillLines(inventory: SkillsInventoryResponse): string[] {
  const lines: string[] = [`project  ${inventory.workingDirectory}`, ''];
  if (inventory.skills.length === 0) {
    // No table: an empty table reads as a broken table.
    lines.push('  no skills found');
  } else {
    lines.push(...renderTable(inventory.skills));
  }
  lines.push('', PLUGIN_LIMITATION);
  return lines;
}

/** The detail page of one skill: what it is for and where it came from. */
function skillDetailLines(inventory: SkillsInventoryResponse, skill: HostSkillEntry): string[] {
  return [
    skill.name,
    ...(skill.description !== '' ? [skill.description] : []),
    '',
    `  source      ${skill.source !== '' ? skill.source : '(unknown)'}`,
    `  invocable   ${skill.userInvocable ? 'yes — the model can run it for you' : 'no — background context only'}`,
    `  enabled     ${skill.enabled ? 'yes' : 'no'}`,
    '',
    `  Invoke it in a message as /${skill.name}${skill.userInvocable ? '' : ' (when invocable)'}.`,
    '',
    PLUGIN_LIMITATION,
    `  project  ${inventory.workingDirectory}`,
  ];
}

/** The interactive list, one selectable entry per skill. */
function skillEntries(inventory: SkillsInventoryResponse): TuiViewEntry[] {
  return inventory.skills.map((skill) => ({
    label: skill.name,
    value: skill.id !== '' ? skill.id : skill.name,
    description: skill.source,
    valueLabel: skill.enabled ? (skill.userInvocable ? 'invocable' : 'context') : 'off',
    summary: skill.description !== '' ? skill.description : undefined,
    detailLines: skillDetailLines(inventory, skill),
  }));
}

const SKILLS_COMMAND: TuiSlashCommandDef = {
  name: 'skills',
  description: 'List available skills',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    let payload: unknown;
    try {
      payload = await ctx.client.listSkills(ctx.session.id);
    } catch (error) {
      const code = hostErrorCode(error);
      // A Host without the inventory capability cannot answer. That is not
      // the same as an empty inventory, and it is rendered differently.
      if (code === 'skill_inventory_api_unavailable') {
        showPanel(ctx, 'Skills', [
          'This Host does not serve the skills inventory, so it cannot answer.',
          '',
          '  That is different from an empty list — here the question was never',
          '  asked of an authority that could answer it.',
          '',
          '  Source: Host skills inventory (GET /v1/skills), 404 skill_inventory_api_unavailable.',
          '',
          PLUGIN_LIMITATION,
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      if (code === 'session_not_found') {
        ctx.tui.printError(
          `Session ${ctx.session.id} is not on this Host, so there are no skills to list for it.`,
        );
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not read the skills inventory: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const inventory = readInventory(payload);
    if (inventory === undefined) {
      ctx.tui.printError(
        'Could not read the skills inventory: the Host answered with something that is not an inventory.',
      );
      return { kind: 'handled' };
    }

    showEntries(ctx, 'Skills', skillEntries(inventory), skillLines(inventory));
    return { kind: 'handled' };
  },
};

export const SKILLS_COMMANDS: readonly TuiSlashCommandDef[] = [SKILLS_COMMAND];
