/**
 * packages/cli/src/tui/slash/session-ops.ts
 *
 * Session lifecycle commands: `/rename`, `/permission`, `/fork`, `/archive`,
 * `/delete`, `/stop`, `/copy`.
 *
 * Every one of them is backed by an endpoint the Host already exposes — this
 * file adds no protocol surface. The split that matters:
 *
 *   - PURE writes (`/rename`, `/permission`) return a `session_updated`
 *     outcome and the chat loop adopts the record.
 *   - LOOP-owned actions (`/fork`, `/archive`, `/delete`, `/stop`) need the
 *     chat loop's queue and transcript, so they go through `ctx.actions`. If
 *     those are absent — a test, or a context with no live loop — the command
 *     says so instead of half-doing it.
 *
 * Destructive commands (`/delete`) confirm first and refuse while a turn is
 * running, because both mistakes are cheap to make and expensive to undo: the
 * run would be cancelled mid-stream, or the session would be gone.
 */

import { execFileSync } from 'node:child_process';
import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';
import { loadSessionMessages, mintSessionId, updateSession } from './shared.js';
import {
  permissionModeFromProfile,
  profileForPermissionMode,
  type TuiPermissionMode,
} from '../permission-mode.js';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messagePreview(content: unknown, limit = 88): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block) => {
          const candidate = block as { readonly type?: unknown; readonly text?: unknown };
          return candidate.type === 'text' && typeof candidate.text === 'string'
            ? candidate.text
            : '';
        }).join(' ')
      : '';
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact === '') return '(no text preview)';
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/** Refuse a session mutation while a turn streams; returns true if refused. */
function refuseWhileBusy(ctx: TuiSlashContext, what: string): boolean {
  if (!ctx.busy) return false;
  ctx.tui.printError(`Cannot ${what} while a turn is running — press Esc first.`);
  return true;
}

function requireActions(ctx: TuiSlashContext): NonNullable<TuiSlashContext['actions']> | null {
  if (ctx.actions === undefined) {
    ctx.tui.printError('This command needs the running chat loop and is unavailable here.');
    return null;
  }
  return ctx.actions;
}

const RENAME_COMMAND: TuiSlashCommandDef = {
  name: 'rename',
  aliases: ['title'],
  argsHint: '[title]',
  description: 'Rename the current session',
  group: 'Session ops',
  async run(ctx, args) {
    const typed = args.trim();
    const prompted = typed === ''
      ? await ctx.tui.promptText?.('Rename session', {
          initialValue: ctx.session.title,
          placeholder: 'Enter a new session title',
        }) ?? null
      : typed;
    if (prompted === null) {
      if (ctx.tui.promptText === undefined && typed === '') {
        ctx.tui.printError('Usage: /rename <new title>');
      }
      return { kind: 'handled' };
    }
    const title = prompted.trim();
    if (title === '') {
      ctx.tui.printError('Session title cannot be empty.');
      return { kind: 'handled' };
    }
    try {
      const session = await updateSession(ctx.client, ctx.session, { title });
      ctx.tui.printNotice(`Renamed to "${session.title}".`);
      return { kind: 'session_updated', session };
    } catch (error) {
      ctx.tui.printError(`Rename failed: ${describeError(error)}`);
      return { kind: 'handled' };
    }
  },
};

/**
 * Composer permission mode ↔ the `permission_profile` the session row stores.
 * Mirrors ChatView's mapping so the two surfaces show the same three modes.
 *
 * The mapping itself lives in `tui/permission-mode.ts`, because the composer's
 * badge and the cycling key use the same vocabulary — a second copy of it here
 * is a second thing that can drift from the badge the user reads.
 */
const PERMISSION_LABELS: Record<TuiPermissionMode, string> = {
  ask: 'ask (ask before each action)',
  auto: 'auto (review automatically, block when unsure)',
  bypass: 'bypass (accept everything — full access)',
};

const PERMISSION_COMMAND: TuiSlashCommandDef = {
  name: 'permission',
  aliases: ['permissions'],
  argsHint: '[ask|auto|bypass]',
  description: 'Show or set the permission mode',
  group: 'Session ops',
  async run(ctx, args): Promise<TuiSlashOutcome> {
    const modes: TuiPermissionMode[] = ['ask', 'auto', 'bypass'];
    const current = permissionModeFromProfile(ctx.session.permissionMode);
    let arg = args.trim().toLowerCase();

    if (arg === '') {
      const picked = await ctx.tui.choose(
        `Permission mode (current: ${current})`,
        modes.map((mode) => ({
          label: `${PERMISSION_LABELS[mode]}${mode === current ? '  (current)' : ''}`,
          value: mode,
        })),
      );
      if (picked === null) {
        // Keep the no-UI command harness useful, and leave a readable result
        // when someone opens the selector and then cancels it.
        const lines = [
          'Permission mode',
          '',
          `  current  ${current}`,
          '',
          ...modes.map((mode) => `  ${PERMISSION_LABELS[mode]}${mode === current ? '   (current)' : ''}`),
          '',
          `  usage    /permission ${modes.join('|')}`,
        ];
        for (const line of lines) ctx.tui.printNotice(line);
        return { kind: 'handled' };
      }
      arg = picked;
    }

    if (!modes.includes(arg as TuiPermissionMode)) {
      ctx.tui.printError(
        `Invalid permission mode "${args.trim()}". Use one of: ${modes.join(' | ')}`,
      );
      return { kind: 'handled' };
    }

    const profile = profileForPermissionMode(arg as TuiPermissionMode);
    if (profile === ctx.session.permissionMode) {
      ctx.tui.printNotice(`Permission mode is already ${arg}.`);
      return { kind: 'handled' };
    }
    try {
      const session = await updateSession(ctx.client, ctx.session, { permissionMode: profile });
      ctx.tui.printNotice(`Permission mode set to ${arg} (${session.permissionMode}).`);
      return { kind: 'session_updated', session };
    } catch (error) {
      ctx.tui.printError(`Permission change failed: ${describeError(error)}`);
      return { kind: 'handled' };
    }
  },
};

const FORK_COMMAND: TuiSlashCommandDef = {
  name: 'fork',
  argsHint: '[messageId]',
  description: 'Fork this session up to a message and switch to the copy',
  group: 'Session ops',
  async run(ctx, args) {
    if (refuseWhileBusy(ctx, 'fork')) return { kind: 'handled' };
    const actions = requireActions(ctx);
    if (actions === null) return { kind: 'handled' };

    const messages = await loadSessionMessages(ctx.client, ctx.session.id, 'llm-visible');
    const requested = args.trim();
    let through: string | undefined;
    if (requested === '') {
      // In the live TUI, bare `/fork` opens a searchable cutoff selector. The
      // latest message is first, so Enter still makes the familiar full-copy
      // choice quickly. Non-interactive hosts keep the old full-copy default.
      const choices = messages.slice().reverse().flatMap((message, index) => {
        if (typeof message.id !== 'string' || message.id === '') return [];
        return [{
          label: [
            index === 0 ? 'Latest · full conversation' : `Message ${messages.length - index}`,
            message.role,
            messagePreview(message.content),
          ].join(' · '),
          value: message.id,
        }];
      });
      const latestId = choices[0]?.value;
      if (latestId !== undefined && ctx.tui.chooseFiltered !== undefined) {
        const picked = await ctx.tui.chooseFiltered('Fork through a message', choices, {
          footer: 'type to filter · ↑↓ choose · Enter select · Esc cancel',
        });
        if (picked === null) return { kind: 'handled' };
        through = picked;
      } else {
        // `forkAt` is inclusive, so the last id keeps the full conversation.
        through = latestId;
      }
    } else {
      through = messages.find((message) => message.id === requested)?.id ?? requested;
    }
    if (through === undefined || through === '') {
      ctx.tui.printError('Nothing to fork: this session has no messages yet.');
      return { kind: 'handled' };
    }

    try {
      const result = await ctx.client.forkAt(ctx.session.id, {
        newSessionId: mintSessionId(),
        throughMessageId: through,
      });
      if (!result.ok) {
        ctx.tui.printError(`Fork failed: ${result.reason}`);
        return { kind: 'handled' };
      }
      await actions.adoptSession(result.sessionId);
      ctx.tui.printNotice(`Forked ${result.seedCount} message(s) into ${result.sessionId.slice(0, 8)}.`);
      return { kind: 'handled' };
    } catch (error) {
      ctx.tui.printError(`Fork failed: ${describeError(error)}`);
      return { kind: 'handled' };
    }
  },
};

const ARCHIVE_COMMAND: TuiSlashCommandDef = {
  name: 'archive',
  description: 'Archive the current session and start a new one',
  group: 'Session ops',
  async run(ctx) {
    if (refuseWhileBusy(ctx, 'archive')) return { kind: 'handled' };
    const actions = requireActions(ctx);
    if (actions === null) return { kind: 'handled' };

    try {
      const result = await ctx.client.archive(ctx.session.id);
      if (!result.ok) {
        ctx.tui.printError(`Archive failed: ${result.reason}`);
        return { kind: 'handled' };
      }
      ctx.tui.printNotice(`Archived ${result.archivedSessionIds.length} session(s).`);
      await actions.startFreshSession();
      return { kind: 'handled' };
    } catch (error) {
      ctx.tui.printError(`Archive failed: ${describeError(error)}`);
      return { kind: 'handled' };
    }
  },
};

const DELETE_COMMAND: TuiSlashCommandDef = {
  name: 'delete',
  description: 'Permanently delete the current session and start a new one',
  group: 'Session ops',
  async run(ctx) {
    if (refuseWhileBusy(ctx, 'delete')) return { kind: 'handled' };
    const actions = requireActions(ctx);
    if (actions === null) return { kind: 'handled' };

    const confirmed = await ctx.tui.choose(
      `Permanently delete "${ctx.session.title || ctx.session.id.slice(0, 8)}"?`,
      [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Delete permanently', value: 'delete' },
      ],
    );
    if (confirmed !== 'delete') {
      ctx.tui.printNotice('Cancelled.');
      return { kind: 'handled' };
    }

    try {
      const result = await ctx.client.delete(ctx.session.id, ctx.session.updatedAt);
      if (!result.deleted) {
        ctx.tui.printError(`Delete failed: ${result.reason}`);
        return { kind: 'handled' };
      }
      ctx.tui.printNotice(`Deleted ${ctx.session.id.slice(0, 8)}.`);
      await actions.startFreshSession();
      return { kind: 'handled' };
    } catch (error) {
      ctx.tui.printError(`Delete failed: ${describeError(error)}`);
      return { kind: 'handled' };
    }
  },
};

const STOP_COMMAND: TuiSlashCommandDef = {
  name: 'stop',
  aliases: ['interrupt'],
  description: 'Interrupt the running turn',
  group: 'Session ops',
  async run(ctx) {
    if (!ctx.busy) {
      ctx.tui.printNotice('No turn is running.');
      return { kind: 'handled' };
    }
    const actions = requireActions(ctx);
    if (actions === null) return { kind: 'handled' };
    actions.interrupt();
    ctx.tui.printNotice('Interrupt requested.');
    return { kind: 'handled' };
  },
};

/** Last assistant message rendered as plain text, or null when there is none. */
async function lastAssistantText(ctx: TuiSlashContext): Promise<string | null> {
  const messages = await loadSessionMessages(ctx.client, ctx.session.id, 'llm-visible');
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    const text = message.content
      .map((block) => {
        const candidate = block as { type?: string; text?: unknown };
        return candidate.type === 'text' && typeof candidate.text === 'string'
          ? candidate.text
          : '';
      })
      .join('')
      .trim();
    return text === '' ? null : text;
  }
  return null;
}

/**
 * Platform clipboard helpers, mirroring the agent CLI's approach: try the
 * native tool, and when none exists print the text instead of failing
 * silently — a copy that reports success without copying is worse than one
 * that shows the content.
 */
const CLIPBOARD_COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['darwin', ['pbcopy']],
  ['win32', ['clip']],
  ['linux', ['wl-copy', 'xclip', '-selection', 'clipboard']],
];

function copyToClipboard(text: string): boolean {
  for (const [platform, commands] of CLIPBOARD_COMMANDS) {
    if (platform !== process.platform) continue;
    try {
      execFileSync(commands[0] as string, commands.slice(1) as string[], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const COPY_COMMAND: TuiSlashCommandDef = {
  name: 'copy',
  description: 'Copy the last assistant reply to the clipboard',
  group: 'Session ops',
  async run(ctx) {
    const text = await lastAssistantText(ctx);
    if (text === null) {
      ctx.tui.printError('No assistant reply to copy yet.');
      return { kind: 'handled' };
    }
    if (copyToClipboard(text)) {
      ctx.tui.printNotice(`Copied ${text.length} characters to the clipboard.`);
    } else {
      ctx.tui.printNotice('No clipboard tool available — here is the reply:');
      ctx.tui.printNotice('');
      ctx.tui.printNotice(text);
    }
    return { kind: 'handled' };
  },
};

export const SESSION_OPS_COMMANDS: readonly TuiSlashCommandDef[] = [
  RENAME_COMMAND,
  PERMISSION_COMMAND,
  FORK_COMMAND,
  ARCHIVE_COMMAND,
  DELETE_COMMAND,
  STOP_COMMAND,
  COPY_COMMAND,
];
