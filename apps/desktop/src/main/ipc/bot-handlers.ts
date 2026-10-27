/**
 * bot-handlers.ts — bot DM turn-scheduling IPC surface (Plan 500 P2).
 *
 *  - `bot:sendTurn`           — the renderer's bot-composer gate. Every bot
 *                               DM send passes through main so the wake
 *                               dispatcher (the authoritative per-bot run
 *                               queue) can decide: run now, queue with lane
 *                               priority, or preempt the in-flight run.
 *  - `bot:claimScheduledTurn` — a renderer window that has the bot's chat
 *                               open accepts a scheduled user turn and will
 *                               run it through its normal streaming path.
 *  - `bot:cancelQueuedTurn`   — drop a queued user turn ("clear queued").
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { getBotSessionId } from '@duya/agent-protocol';
import { defaultBotSessionCreator } from '../wake/agent-dm-dispatcher';
import {
  claimScheduledUserTurn,
  cancelQueuedUserTurn,
  enqueueWakeItemForSession,
} from '../wake/wake-dispatcher';
import { runWakePromptInExistingSession } from '../wake/wake-run';
import {
  cancelDesktopBotInput,
  getDesktopBotSchedulerState,
  listDesktopBotDeliveries,
  getDesktopHostLockApi,
  switchDesktopBotScheduler,
} from '../cli/desktop-host-api';
import { getLogger, LogComponent } from '../logging/logger';
import type { FileAttachment } from '@duya/agent-protocol';

export interface BotSendTurnResult {
  /** 'start' — session idle, renderer runs its normal streaming path. */
  /** 'queued' — parked in the wake queue (preemption already attempted). */
  /** 'accepted' — durable Host inbox owns dispatch; renderer never claims it. */
  action: 'start' | 'queued' | 'accepted';
  messageId: string;
}

/**
 * Hidden first-turn cue sent to a freshly created bot (grok onboarding
 * kickstart parity). The bot has no user message yet; this cue tells it to
 * open the conversation with a greeting and start learning what the user
 * created it for. The prompt is persisted as source 'system' (bot-direct
 * hidden), so only the bot's SendMessage reply surfaces in the chat view.
 */
const BOT_KICKSTART_PROMPT = [
  '[first run] This is your very first turn. The user just created you and has not sent anything yet; this cue is your signal to open the conversation, not a message to reply to or mention.',
  'Greet them and get them going, the way a sharp new assistant would on day one. Open with a short, warm hello in your own voice (your name and description are already in your profile above, so do not recite them), then start learning how to be useful.',
  'If your profile description gives you a concrete assignment, treat that as what the user created you to do: skip the getting-started questions, begin the assignment immediately, and use your first message for a useful result or the next approval you need.',
  'Run getting-started as a real conversation, never a form or a checklist. Ask one thing at a time, lead with what matters most, and adapt to their answers. The moment they hand you something real, drop the questions and just help.',
  'Nothing reaches the user unless it is inside a SendMessage, and offer any choice as a question widget. Do not mention this cue or that you were given setup instructions.',
].join('\n');

export function registerBotHandlers(): void {
  ipcMain.handle('bot:deliveries:list', (_event, data: { botId?: string }) => {
    const botId = typeof data?.botId === 'string' ? data.botId.trim() : '';
    if (!botId) throw new Error('botId is required');
    return listDesktopBotDeliveries(botId);
  });
  ipcMain.handle(
    'bot:sendTurn',
    async (_event, data: { agentId?: string; text?: string; clientMsgId?: string; attachments?: readonly FileAttachment[] }): Promise<BotSendTurnResult> => {
      const agentId = typeof data?.agentId === 'string' ? data.agentId.trim() : '';
      const text = typeof data?.text === 'string' ? data.text.trim() : '';
      if (!agentId) throw new Error('agentId is required');
      if (!text) throw new Error('text is required');
      const messageId =
        typeof data?.clientMsgId === 'string' && data.clientMsgId.trim()
          ? data.clientMsgId.trim()
          : randomUUID();

      const sessionId = getBotSessionId(agentId);
      try {
        await defaultBotSessionCreator.createIfMissing(sessionId, agentId);
      } catch (err) {
        getLogger().warn('bot:sendTurn session ensure failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }, LogComponent.AgentProcess);
      }
      const scheduler = getDesktopBotSchedulerState(agentId);
      if (scheduler.mode === 'host') {
        enqueueWakeItemForSession(sessionId, {
          id: `user:${messageId}`,
          source: 'user.message',
          lane: 'user',
          agentId,
          enqueuedAtMs: Date.now(),
          payload: { kind: 'user', text, messageId, ...(data.attachments ? { attachments: data.attachments } : {}) },
        });
        getLogger().info('bot:sendTurn accepted by Host scheduler', {
          sessionId, messageId,
        }, LogComponent.AgentProcess);
        return { action: 'accepted', messageId };
      }

      const busy = await getDesktopHostLockApi().isSessionLocked(sessionId);
      if (!busy) {
        // Idle → the renderer runs the turn directly through its streaming
        // path. A 409 race (something took the lock in between) surfaces as
        // a failed stream; the composer's retry re-enters this gate.
        getLogger().info('bot:sendTurn idle → start', { sessionId, messageId }, LogComponent.AgentProcess);
        return { action: 'start', messageId };
      }

      // Busy → park on the user lane (strict top priority). Enqueueing also
      // runs the preemption judgment: a user message supersedes any
      // in-flight run (grok "superseded by a new user message"), so the
      // queued turn typically starts right after the interrupt settles.
      const outcome = enqueueWakeItemForSession(sessionId, {
        id: `user:${messageId}`,
        source: 'user.message',
        lane: 'user',
        agentId,
        enqueuedAtMs: Date.now(),
        payload: { kind: 'user', text, messageId, ...(data.attachments ? { attachments: data.attachments } : {}) },
      });
      getLogger().info('bot:sendTurn busy → queued', {
        sessionId,
        messageId,
        outcome,
      }, LogComponent.AgentProcess);
      return { action: 'queued', messageId };
    },
  );

  ipcMain.handle(
    'bot:kickstart',
    async (_event, data: { agentId?: string }): Promise<boolean> => {
      const agentId = typeof data?.agentId === 'string' ? data.agentId.trim() : '';
      if (!agentId) return false;
      const sessionId = getBotSessionId(agentId);
      try {
        // Same get-or-create contract as `bot:sendTurn`: the bot's
        // persistent session must exist before the hidden run targets it.
        await defaultBotSessionCreator.createIfMissing(sessionId, agentId);
      } catch (err) {
        getLogger().warn('bot:kickstart session ensure failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }, LogComponent.AgentProcess);
      }
      if (getDesktopBotSchedulerState(agentId).mode === 'host') {
        enqueueWakeItemForSession(sessionId, {
          id: `kickstart:${agentId}`,
          source: 'bot.kickstart',
          lane: 'background',
          agentId,
          enqueuedAtMs: Date.now(),
          payload: { kind: 'user', text: BOT_KICKSTART_PROMPT, messageId: `kickstart:${agentId}` },
        });
        return true;
      }
      // Hidden first-turn wake: the bot opens the conversation with a
      // greeting. The prompt persists as source 'system' (invisible to the
      // bot-direct chat), so the user only sees the bot's SendMessage reply.
      const outcome = await runWakePromptInExistingSession(sessionId, BOT_KICKSTART_PROMPT, {
        agentProfileId: agentId,
        lane: 'background',
      });
      return outcome.output.length > 0;
    },
  );

  ipcMain.handle(
    'bot:claimScheduledTurn',
    (_event, data: { sessionId?: string; messageId?: string }): boolean => {
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      const messageId = typeof data?.messageId === 'string' ? data.messageId : '';
      if (!sessionId || !messageId) return false;
      const botId = sessionId.startsWith('bot:') ? sessionId.slice(4) : '';
      if (botId && getDesktopBotSchedulerState(botId).mode === 'host') return false;
      return claimScheduledUserTurn(sessionId, messageId);
    },
  );

  ipcMain.handle(
    'bot:cancelQueuedTurn',
    (_event, data: { sessionId?: string; messageId?: string }): boolean => {
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      const messageId = typeof data?.messageId === 'string' ? data.messageId : '';
      if (!sessionId || !messageId) return false;
      const botId = sessionId.startsWith('bot:') ? sessionId.slice(4) : '';
      if (botId && getDesktopBotSchedulerState(botId).mode === 'host') return cancelDesktopBotInput(botId, messageId);
      return cancelQueuedUserTurn(sessionId, messageId);
    },
  );

  ipcMain.handle('bot:scheduler:get', (_event, data: { botId?: string }) => {
    const botId = typeof data?.botId === 'string' ? data.botId.trim() : '';
    if (!botId) throw new Error('botId is required');
    return getDesktopBotSchedulerState(botId);
  });

  ipcMain.handle('bot:scheduler:switch', (_event, data: { botId?: string; mode?: 'legacy' | 'host'; expectedEpoch?: number }) => {
    const botId = typeof data?.botId === 'string' ? data.botId.trim() : '';
    if (!botId || (data?.mode !== 'legacy' && data?.mode !== 'host') || !Number.isSafeInteger(data.expectedEpoch)) {
      throw new Error('botId, mode and expectedEpoch are required');
    }
    return switchDesktopBotScheduler(botId, data.mode, data.expectedEpoch as number);
  });
}
