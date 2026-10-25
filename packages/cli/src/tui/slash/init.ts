/**
 * packages/cli/src/tui/slash/init.ts
 *
 * `/init` — create the repository-root `AGENTS.md`.
 *
 * ## What it writes
 *
 * `AGENTS.md` at the root of the checkout the session runs in: the file every
 * agent reads before touching the repository, so that the rules live in the
 * repository instead of in one agent's head.
 *
 * ## Why the CLI asks the Host
 *
 * The TUI is a pure HTTP client of the Host (see packages/cli/src/chat.ts),
 * and the workspace may be on ANOTHER machine. A CLI that wrote the file
 * locally would write to the wrong filesystem the moment the Host is remote,
 * so the write goes through the Host: `POST /v1/local/agents-md` with the
 * SESSION ID.
 *
 * The request names a session and never a path. The Host owns where the
 * workspace lives, and a path in a client request is a path an attacker
 * chooses.
 *
 * ## The three outcomes
 *
 * "Created", "upgraded" and "left alone" are different facts and the command
 * says which one happened. A file without a duya marker was the USER's own,
 * and overwriting it is reported as such rather than passed over quietly.
 */

import type { InitAgentsMdResult } from '@duya/agent-protocol/doctor';

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError } from './shared.js';

/**
 * The slice of the Host client this command depends on.
 *
 * `writeAgentsMd(sessionId)` ships on `HostSessionHttpClient` together with
 * the Host's route. It is declared here as a structural interface so this
 * file states the contract it calls instead of trusting a payload shape.
 */
interface AgentsMdCapableClient {
  writeAgentsMd(sessionId: string): Promise<InitAgentsMdResult>;
}

const INIT_COMMAND: TuiSlashCommandDef = {
  name: 'init',
  description: 'Create an AGENTS.md at the repository root',
  group: 'Session ops',
  async run(ctx: TuiSlashContext) {
    // A client without the route cannot write anything, and the command says
    // so rather than calling into nothing.
    const client: Partial<AgentsMdCapableClient> = ctx.client;
    if (typeof client.writeAgentsMd !== 'function') {
      ctx.tui.printError(
        'This CLI cannot create the AGENTS.md: its Host client does not offer the write route.',
      );
      return { kind: 'handled' };
    }

    let result: InitAgentsMdResult;
    try {
      result = await client.writeAgentsMd(ctx.session.id);
    } catch (error) {
      ctx.tui.printError(`Could not create the AGENTS.md: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    if (!result.ok) {
      ctx.tui.printError(result.error ?? 'The Host could not create the AGENTS.md.');
      return { kind: 'handled' };
    }

    if (result.unchanged) {
      ctx.tui.printNotice(`The AGENTS.md is already current (v${result.version}); nothing was changed.`);
      return { kind: 'handled' };
    }

    if (result.replacedUnmarked) {
      ctx.tui.printNotice(
        `Replaced ${result.path ?? 'the AGENTS.md'} — it carried no duya marker, so it was your own file.`,
      );
      return { kind: 'handled' };
    }

    if (result.upgraded) {
      ctx.tui.printNotice(`Upgraded ${result.path ?? 'the AGENTS.md'} to v${result.version}.`);
      return { kind: 'handled' };
    }

    ctx.tui.printNotice(`Created ${result.path ?? 'the AGENTS.md'}.`);
    return { kind: 'handled' };
  },
};

export const INIT_COMMANDS: readonly TuiSlashCommandDef[] = [INIT_COMMAND];
