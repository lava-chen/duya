/**
 * Context produced by local `!` shell runs, fed to the agent with the next
 * submitted prompt.
 *
 * ## The semantic this carries over from minimax-code
 *
 * `!cmd` output is the user's own terminal evidence: they ran `!git status`
 * and the next message ("what changed here?") is ABOUT that output. Sending
 * the output as a `terminal-ref` attachment mirrors what the Desktop
 * composer already builds for terminal references, and rides the existing
 * worker attachment pipeline (`buildAttachmentContext` renders the text; a
 * large body is ordinary `text`, so it inlines or truncates there).
 *
 * `!!cmd` (the second bang) opts OUT: the run is still shown in the
 * transcript, but nothing is stored for the next message.
 */

import type { FileAttachment } from '@duya/agent-protocol';

/** minimax-code's cap: the accumulated context never grows past this. */
export const SHELL_CONTEXT_LIMIT = 64 * 1024;

/** One command's transcript entry, exactly the block minimax-code writes. */
export function shellContextEntry(command: string, cwd: string, body: string): string {
  return `$ ${command}\nWorking directory: ${cwd}\n${body}`;
}

/**
 * Accumulate one entry into the pending context, keeping the TAIL on
 * overflow: the most recent commands are the ones the next message is about.
 */
export function appendShellContext(previous: string | null, entry: string): string {
  const combined = previous === null ? entry : `${previous}\n\n${entry}`;
  if (combined.length <= SHELL_CONTEXT_LIMIT) return combined;
  return `[Earlier command context truncated]\n${combined.slice(-SHELL_CONTEXT_LIMIT)}`;
}

/**
 * Wrap the pending context as the attachment the next prompt carries.
 *
 * Field-for-field the Desktop's terminal-ref shape minus its renderer-only
 * extras: `text` is what the worker reads, `name` keeps the command visible
 * in transcripts and digests.
 */
export function shellContextAttachment(context: string, command: string, seq: number): FileAttachment {
  return {
    id: `terminal-ref-${seq}`,
    kind: 'terminal-ref',
    name: `$ ${command}`.slice(0, 100),
    type: 'text/plain',
    url: '',
    size: context.length,
    text: context,
  };
}
