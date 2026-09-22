/**
 * BotActivityIndicator — live "current activity" line for the bot chat.
 *
 * Replaces the static loading bubble (BotTypingIndicator) at the bottom of
 * the transcript: instead of a fixed "思考中/使用工具中" label, it shows a
 * SINGLE rolling line describing exactly what the bot is doing right now:
 *
 *   - thinking   → "思考中" + the latest non-empty thinking line
 *   - tool       → the tool name + a short input summary (command / file
 *                  path / query …). When a NEW tool call starts, the line
 *                  slides in as the new tool — the previous line disappears
 *                  (only the current line is ever shown).
 *   - waiting    → "等待确认" (permission card is rendered alongside)
 *   - error      → "出错了"
 *   - working    → neutral fallback while the turn is active but nothing
 *                  else has been reported yet.
 *
 * The line is driven by ONE subscription to the session stream snapshot
 * (replayed on mount) and hides itself once the bot starts streaming its
 * reply text (the reply bubble itself becomes the visible activity) — i.e.
 * it rolls until the bot actually sends a message.
 *
 * Render contract: the caller gates mounting on `busy` (isStreaming ||
 * isFinalizing); this component returns null when there is nothing current
 * to show (e.g. the bot is writing its reply).
 */

import { useEffect, useRef, useState } from 'react';
import { streamSessionManager } from '@/lib/stream-session-manager';
import type { SessionStreamSnapshot, ToolUseInfo } from '@/types/message';

export type BotActivityKind = 'thinking' | 'tool' | 'waiting' | 'error' | 'working';

export interface BotActivity {
  kind: BotActivityKind;
  /** Primary label — tool name / "思考中" / … */
  label: string;
  /** Optional secondary detail — thinking tail or tool input summary */
  detail?: string;
}

/** Stable identity of the current line: remount (re-animate) when it flips. */
function activityKey(a: BotActivity): string {
  return `${a.kind}:${a.label}:${a.detail ?? ''}`;
}

/** Title-case a raw tool name ("bash__run_command" → "Bash Run Command"). */
function formatToolName(name: string): string {
  return name
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** First line, ellipsized to ~56 chars — the "one line" budget. */
function oneLine(text: string, max = 56): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

const INPUT_SUMMARY_KEYS = [
  'command',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'question',
  'prompt',
  'skill',
  'name',
  'agentName',
  'taskId',
] as const;

/** Short human summary of a tool input: the most telling scalar field. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  for (const key of INPUT_SUMMARY_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
  }
  // Fallback: first primitive-looking field with a stringifiable value.
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim()) return oneLine(v);
    if (typeof v === 'number' || typeof v === 'boolean') return oneLine(String(v));
  }
  return '';
}

/** The latest tool call that has NOT produced its result yet. */
function findActiveTool(snapshot: SessionStreamSnapshot): ToolUseInfo | null {
  const { toolUses, toolResults } = snapshot;
  if (!toolUses || toolUses.length === 0) return null;
  const done = new Set((toolResults ?? []).map((r) => r.tool_use_id));
  for (let i = toolUses.length - 1; i >= 0; i--) {
    if (!done.has(toolUses[i].id)) return toolUses[i];
  }
  return null;
}

/** Last non-empty thinking line — "the line it is on right now". */
function thinkingTail(thinking: string | undefined): string {
  if (!thinking) return '';
  const lines = thinking.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return oneLine(line, 64);
  }
  return '';
}

/**
 * Derive the single current-activity line from a stream snapshot.
 * Exported for tests. Returns null when the line should hide (the bot is
 * streaming its reply text — the message itself is the visible activity).
 */
export function deriveBotActivity(snapshot: SessionStreamSnapshot): BotActivity | null {
  if (snapshot.error || snapshot.phase === 'error') {
    return { kind: 'error', label: '出错了' };
  }

  if (snapshot.phase === 'awaiting_permission') {
    return { kind: 'waiting', label: '等待确认' };
  }

  const activeTool = findActiveTool(snapshot);
  if (activeTool) {
    const input = typeof activeTool.input === 'string'
      ? oneLine(activeTool.input)
      : summarizeToolInput(activeTool.input);
    return { kind: 'tool', label: formatToolName(activeTool.name), detail: input || undefined };
  }

  // Bot started writing its reply → hide (turn output is visible now).
  if (snapshot.streamingContent && snapshot.streamingContent.length > 0) {
    return null;
  }

  const tail = thinkingTail(snapshot.streamingThinkingContent);
  if (tail) {
    return { kind: 'thinking', label: '思考中', detail: tail };
  }

  if (snapshot.phase === 'starting' || snapshot.phase === 'streaming' || snapshot.phase === 'tool_use') {
    return { kind: 'working', label: '正在处理' };
  }

  return null;
}

export function BotActivityIndicator({ sessionId }: { sessionId: string }) {
  const [activity, setActivity] = useState<BotActivity | null>(null);
  const keyRef = useRef<string>('');

  useEffect(() => {
    const unsubscribe = streamSessionManager.subscribeSession(sessionId, (snapshot) => {
      const next = deriveBotActivity(snapshot);
      const nextKey = next ? activityKey(next) : '';
      if (nextKey === keyRef.current) return; // skip identical renders
      keyRef.current = nextKey;
      setActivity(next);
    });
    return unsubscribe;
  }, [sessionId]);

  if (!activity) return null;

  return (
    <div className={`bot-chat-activity bot-chat-activity--${activity.kind}`} role="status" aria-live="polite">
      <span className="bot-chat-activity__spinner" aria-hidden="true" />
      <span key={activityKey(activity)} className="bot-chat-activity__line">
        <span className="bot-chat-activity__label">{activity.label}</span>
        {activity.detail && <span className="bot-chat-activity__detail">{activity.detail}</span>}
      </span>
    </div>
  );
}
