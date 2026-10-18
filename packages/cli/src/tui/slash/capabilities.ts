/**
 * packages/cli/src/tui/slash/capabilities.ts
 *
 * `/capabilities` — what this Host says it can serve, and what this CLI may rely on.
 *
 * ## Why this command exists
 *
 * The capability handshake is otherwise invisible. A CLI that silently assumes
 * a capability is available produces a failure at the moment the user needs the
 * feature, with no explanation; a CLI that refuses silently is worse. This is
 * the surface where the answer is stated before the user acts on it: the
 * provide-side capabilities, the consume-side declaration, and — the part that
 * matters — the requirement this CLI is about to make, with the Host's own
 * reason when it is refused.
 *
 * ## What it deliberately does not do
 *
 * It does not read a workspace file. `requestWorkspaceFileRead` exists and is
 * tested, but the Host route behind it today is the rollout-import endpoint,
 * which is not a file read. Dressing that up as `/read-file` would invent an
 * endpoint the Host does not have. Until the L-HOST lane adds a real one, this
 * command shows the negotiation and the refusal text, which is the part a user
 * can act on.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import {
  CLI_HOST_DECLARATION,
  WORKSPACE_READ_CAPABILITY,
  negotiateHostCapabilities,
} from '../../host-capability-gate.js';

function renderRefusals(lines: string[], refusals: ReadonlyArray<{ readonly capability: string; readonly reason: string }>): void {
  if (refusals.length === 0) {
    lines.push(`  ${WORKSPACE_READ_CAPABILITY}: available`);
    return;
  }
  // The verdict and the Host's own sentence go on separate lines. `describeRefusal`
  // already names the Host and the capability, so inlining it after a
  // `<capability>: unavailable` prefix printed both of them twice.
  for (const refusal of refusals) {
    lines.push(`  ${refusal.capability}: unavailable`);
    lines.push(`    ${refusal.reason}`);
  }
}

const CAPABILITIES_COMMAND: TuiSlashCommandDef = {
  name: 'capabilities',
  description: 'Show what this Host serves and what this CLI may rely on',
  group: 'Session ops',
  async run(ctx: TuiSlashContext, _args: string) {
    try {
      const handshake = await ctx.client.handshake(CLI_HOST_DECLARATION);
      const negotiation = negotiateHostCapabilities(
        CLI_HOST_DECLARATION,
        handshake,
        [WORKSPACE_READ_CAPABILITY],
      );

      const label = handshake.host === undefined
        ? 'this Host'
        : `${handshake.host.name} ${handshake.host.version}`;
      const lines = [
        `Host ${label}`,
        // `null` means the Host said nothing at all. Printing an empty list
        // there would read as "serves nothing", which is a different claim.
        negotiation.provided === null
          ? '  provides: not declared — refusing rather than assuming support'
          : `  provides (${negotiation.provided.length}): ${negotiation.provided.join(', ') || '(none)'}`,
        `  consumes (${negotiation.consumed.length}): ${negotiation.consumed.join(', ') || '(none)'}`,
        'Requirements this CLI makes:',
      ];
      renderRefusals(lines, negotiation.refused);
      for (const line of lines) ctx.tui.printNotice(line);
    } catch (error) {
      ctx.tui.printError(
        `Capability handshake failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { kind: 'handled' };
  },
};

export const CAPABILITIES_COMMANDS: readonly TuiSlashCommandDef[] = [CAPABILITIES_COMMAND];
