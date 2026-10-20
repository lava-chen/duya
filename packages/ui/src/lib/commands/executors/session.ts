/**
 * Session executors: new / clear / export / copy / rename / resume / stop /
 * queue / compact.
 *
 * Everything that touches the live app goes through `ctx.app` (the composer
 * bridge). The two exceptions are deliberate and both are plain module
 * singletons the composer already loads:
 *   - `useConversationStore` — the transcript rows and the thread title
 *     (executors are functions, not components, so `getState()` not a hook),
 *   - `stream-session-manager` — the pending-message queue, the same
 *     `hasQueuedMessages` source MessageInput and App.tsx read.
 *
 * `/compact` is the `manual` trigger worker-compaction documents as "a slash
 * command handled outside the loop entirely"
 * (packages/host/src/worker-compaction/engine-sources.ts), and `/queue clear`
 * mirrors App.tsx's second-Esc gesture so both queues drop together.
 */

import type { CommandExecutorFn } from './registry';
import type { CommandContext } from '../types';
import type { Message } from '@/types/message';
import { useConversationStore } from '@/stores/conversation-store';
import {
  clearQueuedMessages,
  getPendingMessages,
  hasQueuedMessages,
} from '@/lib/stream-session-manager';
import { exportRolloutIPC } from '@/lib/ipc-client';
import { resolveChatMode } from '@/components/chat/bot/chat-mode';
import { cancelPendingTurnsForSession } from '@/components/chat/bot/send/scheduled-turns';

// ============================================================================
// Shared readers
// ============================================================================

interface ActiveThread {
  threadId: string | null;
  title: string;
  messages: Message[];
}

/**
 * The thread the command acts on: the composer's session id wins, the store's
 * `activeThreadId` is the fallback for the moment before the composer mounts.
 */
function activeThread(ctx: CommandContext): ActiveThread {
  const store = useConversationStore.getState();
  const threadId = ctx.app?.getSessionSnapshot().sessionId || store.activeThreadId || null;
  const thread = store.threads.find((t) => t.id === threadId);
  return {
    threadId,
    title: thread?.title?.trim() ?? '',
    messages: threadId ? store.messages[threadId] ?? [] : [],
  };
}

/**
 * Plain Markdown out of a message, for clipboard and transcript rendering.
 * Mirrors MessageItem's `extractMarkdownFromBlocks`: commentary blocks are
 * skipped and raw block JSON never reaches the user.
 */
function messageText(message: Message): string {
  const source =
    message.role === 'user' && message.displayContent ? message.displayContent : message.content;
  if (typeof source === 'string') return source;
  if (!Array.isArray(source)) return '';
  const parts: string[] = [];
  for (const block of source) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'text' || record.phase === 'commentary') continue;
    if (typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('');
}

/** Best-effort clipboard write. False means "no clipboard", not an error. */
async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Transcript markdown
// ============================================================================

const ROLE_HEADINGS: Record<Message['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

/**
 * Markdown transcript for `/export`. Deterministic and never throws — a
 * compaction summary is marked in place so the reader can tell where older
 * context was replaced.
 */
function buildTranscriptMarkdown(thread: ActiveThread, workingDirectory?: string | null): string {
  const lines: string[] = [`# ${thread.title || 'Untitled session'}`, ''];
  lines.push(`- Session: ${thread.threadId ?? '(draft)'}`);
  if (workingDirectory) lines.push(`- Working directory: ${workingDirectory}`);
  lines.push(`- Exported: ${new Date().toISOString()}`);
  lines.push(`- Messages: ${thread.messages.length}`);
  lines.push('');

  for (const message of thread.messages) {
    if (message.isCompactBoundary) {
      lines.push('---', '', '_context compacted here_', '');
      continue;
    }
    const heading = message.isCompactSummary
      ? `${ROLE_HEADINGS[message.role]} (compaction summary)`
      : ROLE_HEADINGS[message.role];
    const text = messageText(message).trim();
    if (!text) continue;
    lines.push(`## ${heading}`, '', text, '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ============================================================================
// Queue helpers
// ============================================================================

/** One-line preview of a queued prompt, for the `/queue` listing. */
function preview(text: string, limit = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

// ============================================================================
// Executors
// ============================================================================

export const SESSION_EXECUTORS: Record<string, CommandExecutorFn> = {
  /** Start a fresh chat — same gesture as "新建对话". */
  new: async (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/new: app bridge unavailable' };
    const { newSessionId } = await app.resetSession();
    return { type: 'session_reset', newSessionId: newSessionId || undefined };
  },

  /**
   * Clear the visible transcript. The store action is the desktop semantic
   * (CLI parity with `tui.clearTranscript()`): DB history is preserved, the
   * worker keeps its own copy.
   */
  clear: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/clear: app bridge unavailable' };
    app.clearMessages();
    app.toast('已清空当前对话（DB 历史保留）', 'success');
    return { type: 'dismiss' };
  },

  /**
   * `/export`            → Markdown transcript of the visible conversation.
   * `/export rollout`    → the session's rollout JSONL, written to disk by the
   *                       main process (`db:rollout:export`) — the one export
   *                       path that can produce a file today.
   *
   * The Markdown branch lands on the clipboard: the renderer has no
   * `dialog.showSaveDialog` and no fs write channel (preload's `dialog` only
   * *reads* paths via openFolder/openFile), so writing a file from here would
   * need a new main-process IPC. See the report — that gap is the only reason
   * the default branch copies instead of saving.
   */
  export: async (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/export: app bridge unavailable' };

    const format = (ctx.args[0] ?? '').toLowerCase();
    if (format && !['markdown', 'md', 'rollout', 'jsonl'].includes(format)) {
      return {
        type: 'error',
        message: [
          `/export: 未知的格式 "${ctx.args[0]}"。`,
          '可选：/export（Markdown 转录）、/export rollout（rollout JSONL 文件）',
        ].join('\n'),
      };
    }

    const thread = activeThread(ctx);
    if (!thread.threadId) {
      return { type: 'error', message: '/export: 当前没有打开的会话，无法导出。' };
    }

    if (['rollout', 'jsonl'].includes(format)) {
      try {
        const result = await exportRolloutIPC(thread.threadId);
        app.toast('Rollout 已导出', 'success');
        return {
          type: 'text',
          content: [
            `已导出 ${result.lines} 行（${result.bytes} 字节）：`,
            result.absolutePath,
          ].join('\n'),
        };
      } catch (error) {
        return {
          type: 'error',
          message: `/export: 导出 rollout 失败（${error instanceof Error ? error.message : String(error)}）`,
        };
      }
    }

    if (thread.messages.length === 0) {
      return { type: 'error', message: '/export: 当前会话还没有消息可导出。' };
    }

    const markdown = buildTranscriptMarkdown(thread, app.getSessionSnapshot().workingDirectory);
    const copied = await writeClipboard(markdown);
    const header = `已生成 Markdown 转录（${thread.messages.length} 条消息）。`;

    if (!copied) {
      return {
        type: 'error',
        message: [
          `${header}`,
          '剪贴板不可用，且桌面端尚无「保存对话框」写入通道，转录无法落地。',
          '改用 /export rollout 可由主进程写出 rollout JSONL 文件。',
        ].join('\n'),
      };
    }

    app.toast('Markdown 转录已复制到剪贴板', 'success');
    return {
      type: 'text',
      content: [
        header,
        '已复制到剪贴板，可直接粘贴保存。',
        '需要落盘为文件请用 /export rollout（rollout JSONL）。',
      ].join('\n'),
    };
  },

  /** Copy the last assistant reply — no args means the newest reply. */
  copy: async (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/copy: app bridge unavailable' };

    const { messages } = activeThread(ctx);
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && messageText(m).trim());
    if (!last) {
      return { type: 'error', message: '/copy: 当前会话还没有可复制的回复。' };
    }

    const text = messageText(last);
    if (await writeClipboard(text)) {
      app.toast('已复制最后一条回复', 'success');
      return { type: 'dismiss' };
    }
    return { type: 'text', content: `剪贴板不可用，最后一条回复如下：\n\n${text}` };
  },

  /** `/rename [name]` → prompt for the title; `/rename 名字` → set directly. */
  rename: async (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/rename: app bridge unavailable' };

    const thread = activeThread(ctx);
    if (!thread.threadId) {
      return { type: 'error', message: '/rename: 当前没有打开的会话，先新建或打开一个会话。' };
    }

    const typed = ctx.args.join(' ').trim();
    const next = typed
      ? typed
      : await app.promptInput({
          title: '重命名会话',
          placeholder: '输入新的会话标题',
          initialValue: thread.title,
        });
    if (next === null) return { type: 'dismiss' };

    const title = next.trim();
    if (!title) return { type: 'error', message: '/rename: 标题不能为空。' };

    useConversationStore.getState().updateThreadTitle(thread.threadId, title);
    app.toast('会话已重命名', 'success');
    return { type: 'text', content: `会话已重命名为「${title}」。` };
  },

  /** Alias entry — dispatch resolves aliases through the canonical name. */
  title: (ctx) => SESSION_EXECUTORS.rename(ctx),

  /** Open the session switcher — desktop parity with CLI `/resume`. */
  resume: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/resume: app bridge unavailable' };

    const sessionId = app.getSessionSnapshot().sessionId;
    if (!sessionId) {
      return {
        type: 'text',
        content: '当前处于新对话状态，还没有打开的会话。请先从左侧会话列表中选择要恢复的会话。',
      };
    }
    app.openPanel('sessions');
    return { type: 'dismiss' };
  },

  /** Alias entry — see the note on `title`. */
  sessions: (ctx) => SESSION_EXECUTORS.resume(ctx),

  /** Interrupt the live turn (Esc equivalent); works mid-stream. */
  stop: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/stop: app bridge unavailable' };
    app.stopTurn();
    app.toast('已请求停止当前回合', 'info');
    return { type: 'dismiss' };
  },

  /**
   * `/queue`          → list pending follow-ups.
   * `/queue clear`   → drop them (also cancels the bot-direct wake queue,
   *                    the same pair App.tsx clears on a double Esc).
   * `/queue resume`  → report the drain rule: the manager starts queued
   *                    messages itself when the current run ends, so there is
   *                    no "flush now" API to call from here.
   */
  queue: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/queue: app bridge unavailable' };

    const sessionId = app.getSessionSnapshot().sessionId;
    if (!sessionId) {
      return { type: 'text', content: '当前没有打开的会话，没有待发队列。' };
    }

    const sub = (ctx.args[0] ?? '').toLowerCase();

    if (sub === 'clear') {
      if (!hasQueuedMessages(sessionId)) {
        return { type: 'text', content: '队列为空，无需清空。' };
      }
      clearQueuedMessages(sessionId);
      if (resolveChatMode(sessionId) === 'bot-direct') {
        cancelPendingTurnsForSession(sessionId);
      }
      app.toast('已清空待发队列', 'success');
      return { type: 'dismiss' };
    }

    if (sub === 'resume') {
      return {
        type: 'text',
        content: hasQueuedMessages(sessionId)
          ? '待发消息会在当前回合结束后自动发送，无需手动恢复。'
          : '队列为空，没有需要恢复的消息。',
      };
    }

    if (sub) {
      return {
        type: 'error',
        message: [`/queue: 未知的子命令 "${ctx.args[0]}"。`, '可选：clear | resume'].join('\n'),
      };
    }

    const pending = getPendingMessages(sessionId);
    if (pending.length === 0) {
      return { type: 'text', content: '队列为空（没有待发消息）。' };
    }
    const lines = [`队列中有 ${pending.length} 条待发消息：`, ''];
    pending.forEach((item, index) => {
      lines.push(`${index + 1}. ${preview(item.displayContent || item.content)}`);
    });
    lines.push('', '/queue clear 清空队列 · /queue resume 说明发送时机');
    return { type: 'text', content: lines.join('\n') };
  },

  /** Manual context compaction — the loop-external `manual` trigger. */
  compact: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/compact: app bridge unavailable' };
    if (!app.getSessionSnapshot().sessionId) {
      return { type: 'error', message: '/compact: 当前没有打开的会话，无法压缩上下文。' };
    }
    app.compactContext();
    app.toast('已开始压缩上下文（后台运行）', 'info');
    return { type: 'dismiss' };
  },
};
