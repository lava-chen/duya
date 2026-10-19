/**
 * packages/cli/src/tui/slash/read-file.ts
 *
 * `/read-file <workspace-relative-path>` — the first thing in the product that
 * actually CONSUMES `workspace_filesystem`.
 *
 * ## Why the capability needed a real user-facing action to be real
 *
 * `/capabilities` prints the negotiation. A negotiation nobody acts on is a
 * status line, not a capability: nothing has yet proved that a Host advertising
 * `workspace_filesystem` can serve a read. This command is that proof in
 * production — it asks for a file, and prints either the file or the Host's own
 * refusal.
 *
 * ## Why the path is workspace-relative
 *
 * The Host resolves a Workspace ID plus a relative path; it never accepts a host
 * path from a client. That is not a style choice. An absolute-path API would put
 * "which files can this caller read" back into the client, and this CLI is
 * exactly the kind of surface that would forward whatever it was handed.
 *
 * `ctx.session.workspace` is where the Workspace comes from: the user is already
 * inside a session, so naming a workspace again would be a second source of
 * truth for the same question. A session that predates workspace identity says
 * so instead of guessing.
 *
 * ## What it prints when the read is refused
 *
 * The Host's sentence, not a paraphrase. `/capabilities` exists for the
 * diagnosis; this command exists for the answer, and the answer is that the Host
 * refused.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { CLI_HOST_DECLARATION, requestWorkspaceFileRead } from '../../host-capability-gate.js';

/** Lines of a file worth putting on a transcript before it becomes a wall. */
const PREVIEW_LINES = 40;

function preview(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= PREVIEW_LINES) return content;
  return `${lines.slice(0, PREVIEW_LINES).join('\n')}\n… ${lines.length - PREVIEW_LINES} more line(s); the read returned ${content.length} characters`;
}

const READ_FILE_COMMAND: TuiSlashCommandDef = {
  name: 'read-file',
  description: 'Read a file from this session\'s workspace through the Host',
  group: 'Session ops',
  async run(ctx: TuiSlashContext, args: string) {
    const relativePath = args.trim();
    if (relativePath.length === 0) {
      ctx.tui.printError('Usage: /read-file <workspace-relative-path>');
      return { kind: 'handled' };
    }

    const workspace = ctx.session.workspace;
    if (workspace.state !== 'bound') {
      // Not a failure to work around: the identity this read needs is the thing
      // the session is missing, so any path we invented here would be a guess.
      ctx.tui.printError(
        `This session has no workspace identity, so the Host cannot resolve "${relativePath}". Reopen the session from a workspace directory.`,
      );
      return { kind: 'handled' };
    }

    try {
      const handshake = await ctx.client.handshake(CLI_HOST_DECLARATION);
      const outcome = await requestWorkspaceFileRead(ctx.client, handshake, workspace.workspaceId, relativePath);
      if (outcome.status === 'refused') {
        ctx.tui.printError(outcome.reason);
        return { kind: 'handled' };
      }

      const { result } = outcome;
      const summary = result.truncated
        ? `${result.relativePath} — ${result.content.length} of ${result.totalBytes} bytes`
        : `${result.relativePath} — ${result.totalBytes} bytes`;
      ctx.tui.printNotice(summary);
      for (const line of preview(result.content).split('\n')) ctx.tui.printNotice(line);
    } catch (error) {
      ctx.tui.printError(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { kind: 'handled' };
  },
};

export const READ_FILE_COMMANDS: readonly TuiSlashCommandDef[] = [READ_FILE_COMMAND];
