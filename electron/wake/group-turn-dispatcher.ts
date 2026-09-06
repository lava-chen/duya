/**
 * group-turn-dispatcher.ts — shared-room turn execution chain (Plan 478 P2.2).
 *
 * The room itself never runs an LLM (grok parity: "the room session itself
 * never runs an LLM"). This module is the room-level orchestrator host in
 * electron main, sibling of agent-dm-dispatcher / idle-dispatcher:
 *
 *   trigger (user post / bot post_to_room / automation)
 *     → scheduleGroupTurn bumps the room turn epoch and queues one
 *       GroupChatOrchestrator run on a per-room promise chain
 *     → each member turn = one hidden wake run on the member's persistent
 *       bot session (`bot:<agentId>`) via the cron/wake HTTP chain, carrying
 *       the group prompt (transcript window + room rules + turn instruction)
 *     → the member speaks through `post_to_room`, whose authored entry lands
 *       in the room transcript; the orchestrator counts posts from the run's
 *       SSE events (the tool already persisted them)
 *     → (pass) / caps / stale epoch end the turn
 *
 * Concurrency model (plan 478 §6 audit): member turns run SEQUENTIALLY via
 * `runWakePromptInExistingSession`; the agent-server STREAMING state machine
 * rejects a member turn with 409 when the member is busy (a user DM owns the
 * session) — a 409 is treated as a pass, not a room failure. A user post
 * interrupts the in-flight member run (interruptCronSession) and bumps the
 * epoch so the remaining plan is voided; the new turn then runs from the
 * chained queue.
 */

import { getCoreStores } from '../db/core-connection';
import { randomUUID } from 'crypto';
import type { NewEvent } from '../db/core';
import { ipcMessageToNewEvent, newEventToIpcMessage } from '../ipc/core-db-adapters';
import { getSessionManager } from '../agents/session-manager';
import { listConfigAgents } from '../config/agents';
import { listGroups } from '../config/groups';
import { ROOM_HISTORY_SOURCES } from '../../packages/agent/src/message/message-source';
import {
  GroupChatOrchestrator,
  type GroupMember,
  type GroupMessage,
} from '../../packages/agent/src/wake/groupTurn';
import { getRoomSessionId, parseRoomIdFromSession } from '../../packages/agent/src/agent/dm/bot-session-id';
import { defaultBotSessionCreator } from './agent-dm-dispatcher';
import { dispatchBotTurn } from './wake-dispatcher';
import { interruptCronSession } from '../automation/agent-run';
import { getLogger, LogComponent } from '../logging/logger';

/** Room-turn lifecycle notice source (rendered as a system row in the UI). */
export interface GroupPostMeta {
  roomId: string;
  roomName?: string;
  memberId?: string;
  memberName?: string;
  text?: string;
  clientMsgId?: string;
}

interface RoomState {
  /** Bumped on every trigger (grok nextTurnEpoch). */
  epoch: number;
  /** Chained turn runs — one at a time per room, in trigger order. */
  queue: Promise<void>;
  /** Session id of the member turn currently in flight (for interrupts). */
  currentMemberSession?: string;
}

const rooms = new Map<string, RoomState>();

function getRoomState(sessionId: string): RoomState {
  let state = rooms.get(sessionId);
  if (!state) {
    state = { epoch: 0, queue: Promise.resolve() };
    rooms.set(sessionId, state);
  }
  return state;
}

/** Test seam — drop every room state. */
export function _resetGroupTurnDispatcherForTest(): void {
  rooms.clear();
}

// ─── Room session + transcript plumbing ───

/**
 * Idempotently create the room's transcript session row (`room:<roomId>`,
 * agentType 'room'). The room never runs an agent — the row only anchors the
 * MessageLog rollout file, the renderer thread list and the source-filtered
 * transcript reads.
 */
export function ensureRoomSession(roomId: string, title: string): string {
  const sessionId = getRoomSessionId(roomId);
  const { sessions } = getCoreStores();
  if (sessions.get(sessionId)) return sessionId;
  sessions.create({
    id: sessionId,
    title,
    status: 'active',
    mode: 'chat',
    permissionMode: 'auto',
    agentType: 'room',
    agentName: title,
    extensions: { source: 'room' },
  });
  return sessionId;
}

/**
 * Append one authored entry to a room transcript and broadcast it to every
 * renderer (`message:new`). Used for user posts and room lifecycle notices;
 * bot posts arrive through the `message:append` bridge instead.
 */
export function appendRoomEntry(
  sessionId: string,
  message: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    source: 'user' | 'group_system';
    metadata?: Record<string, unknown>;
  },
): void {
  try {
    const { messageLog } = getCoreStores();
    const event: NewEvent = ipcMessageToNewEvent(
      sessionId,
      { ...message, created_at: Date.now() } as unknown as Parameters<typeof ipcMessageToNewEvent>[1],
      null,
    );
    messageLog.appendBatch([event]);
    const broadcast = newEventToIpcMessage(event);
    if (broadcast) {
      getSessionManager().broadcastSessionEvent('message:new', {
        sessionId,
        messages: [broadcast],
      });
    }
  } catch (err) {
    getLogger().warn('GroupTurn: room entry append failed (non-fatal)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.AgentProcess);
  }
}

/**
 * Project the room transcript into the orchestrator's GroupMessage history
 * (grok readGroupHistory parity): user entries → `{kind:'user'}`, bot
 * entries (role assistant + metadata.groupPost) → `{kind:'member'}`. Only
 * `ROOM_HISTORY_SOURCES` rows participate; streaming previews don't exist
 * here because room posts are written complete.
 */
export function readGroupHistory(sessionId: string): GroupMessage[] {
  let rows: Array<{ payload: string }> = [];
  try {
    rows = getCoreStores().messageLog.listBySession(sessionId, {
      source: ROOM_HISTORY_SOURCES,
    }) as unknown as Array<{ payload: string }>;
  } catch (err) {
    getLogger().warn('GroupTurn: history read failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.AgentProcess);
    return [];
  }
  const history: GroupMessage[] = [];
  for (const row of rows) {
    let entry: {
      type?: string;
      message?: { role?: string; content?: unknown; metadata?: { groupPost?: GroupPostMeta } };
    };
    try {
      entry = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (entry?.type !== 'message' || !entry.message) continue;
    const role = entry.message.role;
    const content = typeof entry.message.content === 'string' ? entry.message.content : '';
    if (!content.trim()) continue;
    if (role === 'user') {
      history.push({ speaker: { kind: 'user' }, content });
      continue;
    }
    if (role === 'assistant') {
      const post = entry.message.metadata?.groupPost;
      if (!post?.memberId) continue;
      history.push({
        speaker: { kind: 'member', id: post.memberId, name: post.memberName || post.memberId },
        content,
      });
    }
  }
  return history;
}

// ─── Member turn run ───

/** Extract post_to_room texts from a wake run's SSE events (counting only —
 * the tool already persisted the authored entries). */
function collectRoomPosts(events: ReadonlyArray<{ type: string; data?: unknown }>): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const data = event.data as { name?: unknown; input?: { text?: unknown } } | undefined;
    if (data?.name !== 'post_to_room') continue;
    const text = typeof data.input?.text === 'string' ? data.input.text : '';
    texts.push(text.trim() || '(room post)');
  }
  return texts;
}

// ─── Room turn orchestration ───

/**
 * Schedule one room turn (grok send-group-fanout parity): bump the epoch,
 * queue the orchestrator run. Stale runs (a newer trigger bumped the epoch
 * while queued) no-op at their isCurrent checks.
 */
export function scheduleGroupTurn(
  roomId: string,
  trigger: 'user' | 'agent' | 'automation',
): void {
  const sessionId = getRoomSessionId(roomId);
  const state = getRoomState(sessionId);
  const epoch = state.epoch + 1;
  state.epoch = epoch;

  // Plan 478 §2.4: a user message interrupts the in-flight member run and
  // voids the remaining plan; bot/automation posts wait for the chained turn.
  if (trigger === 'user' && state.currentMemberSession) {
    const memberSession = state.currentMemberSession;
    getLogger().info('GroupTurn: user post interrupts in-flight member run', {
      roomId,
      memberSession,
    }, LogComponent.AgentProcess);
    try {
      interruptCronSession(memberSession);
    } catch (err) {
      getLogger().warn('GroupTurn: member interrupt failed', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.AgentProcess);
    }
  }

  state.queue = state.queue
    .then(() => runRoomTurn(roomId, sessionId, epoch))
    .catch((err) => {
      getLogger().warn('GroupTurn: room turn crashed', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.AgentProcess);
    });
}

async function runRoomTurn(roomId: string, sessionId: string, epoch: number): Promise<void> {
  const state = getRoomState(sessionId);
  if (state.epoch !== epoch) return; // superseded while queued

  const group = (await listGroups())[roomId];
  if (!group || group.memberIds.length === 0) {
    getLogger().warn('GroupTurn: room missing from declaration; turn skipped', { roomId }, LogComponent.AgentProcess);
    return;
  }
  if (state.epoch !== epoch) return; // superseded during config read

  getLogger().info('GroupTurn: room turn starting', {
    roomId,
    group: group.name,
    members: group.memberIds,
    triggerEpoch: epoch,
  }, LogComponent.AgentProcess);

  const deps = {
    resolveMembers: async (ids: readonly string[]): Promise<GroupMember[]> => {
      const agents = listConfigAgents();
      return ids
        .filter((id) => agents[id] !== undefined)
        .map((id) => ({
          id,
          name: agents[id].name || id,
          description: agents[id].description || '',
        }));
    },
    readHistory: (): GroupMessage[] => readGroupHistory(sessionId),
    isCurrent: (): boolean => getRoomState(sessionId).epoch === epoch,
    runMemberTurn: async ({ member, systemPrompt, prompt }: {
      member: GroupMember;
      systemPrompt: string;
      prompt: string;
    }): Promise<readonly string[]> => {
      if (getRoomState(sessionId).epoch !== epoch) return [];
      // Ensure the member's persistent bot session exists (same get-or-create
      // as the DM dispatcher) — the group turn runs on the member's session.
      try {
        defaultBotSessionCreator.createIfMissing(`bot:${member.id}`, member.id);
      } catch (err) {
        getLogger().warn('GroupTurn: member session ensure failed', {
          roomId,
          member: member.id,
          error: err instanceof Error ? err.message : String(err),
        }, LogComponent.AgentProcess);
      }
      // duya folds the group conduct block into the wake prompt head — the
      // member's bot session already carries its persona system prompt.
      const combinedPrompt = `${systemPrompt}\n\n${prompt}`;
      state.currentMemberSession = `bot:${member.id}`;
      try {
        // Plan 500 P4: member turns go through the bot run scheduler. Busy
        // member (user DM in flight) → the item parks on the agent lane
        // instead of 409-passing; a user message preempts the member run
        // and it redrives after the user's turn.
        const outcome = await dispatchBotTurn(`bot:${member.id}`, {
          id: `group:${roomId}:${epoch}:${member.id}:${randomUUID()}`,
          source: 'group.turn',
          lane: 'agent',
          agentId: member.id,
          enqueuedAtMs: Date.now(),
          payload: { kind: 'group', roomId, text: combinedPrompt },
        });
        return collectRoomPosts(outcome.events ?? []);
      } catch (err) {
        // A failed member turn is a pass, not a room-wide failure (grok).
        getLogger().warn('GroupTurn: member turn failed; treated as pass', {
          roomId,
          member: member.id,
          error: err instanceof Error ? err.message : String(err),
        }, LogComponent.AgentProcess);
        return [];
      } finally {
        state.currentMemberSession = undefined;
      }
    },
    postMemberMessage: (): void => {
      // The post_to_room tool already wrote the authored entry to the room
      // transcript from the worker; the orchestrator only counts.
    },
  };

  await new GroupChatOrchestrator(deps).run({
    group: { name: group.name },
    memberIds: group.memberIds,
    maxRounds: group.maxRounds,
    maxMemberTurns: group.maxMemberTurns,
  });

  if (getRoomState(sessionId).epoch === epoch) {
    appendRoomEntry(sessionId, {
      id: `room-turn-${roomId}-${epoch}`,
      role: 'system',
      content: `Group turn concluded (round limit ${group.maxRounds}, turn limit ${group.maxMemberTurns}).`,
      source: 'group_system',
    });
    getLogger().info('GroupTurn: room turn concluded', { roomId, epoch }, LogComponent.AgentProcess);
  }
}

/**
 * Bridge hook — called from db-bridge `message:append` for appends whose
 * session is a room transcript. Detects an authored bot entry
 * (metadata.groupPost) and schedules the room turn. Returns true when a
 * turn was scheduled.
 */
export function maybeScheduleGroupTurnFromAppend(
  sessionId: string,
  messages: ReadonlyArray<Record<string, unknown>>,
): boolean {
  const roomId = parseRoomIdFromSession(sessionId);
  if (!roomId) return false;
  const hasBotPost = messages.some((msg) => {
    const meta = msg?.metadata as { groupPost?: GroupPostMeta } | undefined;
    return meta?.groupPost?.roomId != null;
  });
  if (!hasBotPost) return false;
  scheduleGroupTurn(roomId, 'agent');
  return true;
}
