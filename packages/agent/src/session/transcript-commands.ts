/**
 * Deterministic /export /copy /transcript command handling (plan 554,
 * minimax command parity).
 *
 * The desktop path intercepts these at streamChat entry (same mechanism as
 * the /goal control verbs): no LLM turn is spent on transcript plumbing.
 * The CLI registers the same verbs against the shared builders here.
 *
 *  - `/export [path]`  — write the session transcript as Markdown; default
 *    path is `transcript-<timestamp>.md` in the session working directory.
 *  - `/copy`           — copy the last assistant reply to the clipboard.
 *    On the desktop the copy itself happens renderer-side: the worker
 *    emits a `chat:clipboard_write` event and the reply confirms. CLI
 *    pipes through `clip`/`pbcopy` instead.
 *  - `/transcript`     — transcript info + pointer to /export (the desktop
 *    transcript IS the chat; the CLI prints a paged view on its own).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { buildTranscriptMarkdown, getLastReplyText } from './transcript-md.js';
import type { Message } from '../types.js';
import { logger } from '../utils/logger.js';
import { expandPath } from '../utils/path.js';

export interface TranscriptCommandContext {
  /** Snapshot of the session messages (agent.getMessages()). */
  messages: readonly Message[];
  sessionId?: string;
  workingDirectory?: string;
}

export interface TranscriptCommandResult {
  handled: boolean;
  reply: string;
  /** Set for `/copy`: the renderer must write this to the clipboard. */
  clipboardText?: string;
}

const CONTROL_VERBS = new Set(['export', 'copy', 'transcript']);

export function isTranscriptControlCommand(prompt: string): boolean {
  const trimmed = (prompt ?? '').trim();
  if (!trimmed.toLowerCase().startsWith('/')) return false;
  const verb = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
  return CONTROL_VERBS.has(verb);
}

/** Run a deterministic transcript command. Never throws. */
export function handleTranscriptCommand(
  prompt: string,
  ctx: TranscriptCommandContext,
): TranscriptCommandResult {
  const trimmed = (prompt ?? '').trim();
  const verb = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
  const args = trimmed.slice(1 + verb.length).trim();

  try {
    switch (verb) {
      case 'export':
        return { handled: true, reply: exportTranscript(args, ctx) };
      case 'copy': {
        const text = getLastReplyText(ctx.messages);
        if (!text) return { handled: true, reply: 'No assistant reply to copy yet.' };
        return {
          handled: true,
          reply: 'Last reply copied to the clipboard.',
          clipboardText: text,
        };
      }
      case 'transcript': {
        const lastReply = getLastReplyText(ctx.messages);
        return {
          handled: true,
          reply: [
            `Transcript: ${ctx.messages.length} message(s) in this session.`,
            lastReply ? 'The full conversation is visible above; use /export [path] to write it to a Markdown file, or /copy for the last reply.' : 'Use /export [path] to write it to a Markdown file.',
          ].join('\n'),
        };
      }
      default:
        return { handled: false, reply: '' };
    }
  } catch (err) {
    logger.warn(
      `[TranscriptCommand] /${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      handled: true,
      reply: `Transcript command failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function exportTranscript(args: string, ctx: TranscriptCommandContext): string {
  if (ctx.messages.length === 0) {
    return 'Nothing to export yet — the transcript is empty.';
  }
  const markdown = buildTranscriptMarkdown(ctx.messages, { sessionId: ctx.sessionId });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  const defaultPath = `transcript-${stamp}.md`;
  const target = expandPath(args || defaultPath, ctx.workingDirectory || undefined);
  const absolute = isAbsolute(target) ? target : resolve(ctx.workingDirectory || process.cwd(), target);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown, 'utf-8');
  const kb = (Buffer.byteLength(markdown, 'utf-8') / 1024).toFixed(1);
  return `Transcript exported: ${absolute} (${ctx.messages.length} messages, ${kb} KB)`;
}
