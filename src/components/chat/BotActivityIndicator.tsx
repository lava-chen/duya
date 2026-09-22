/**
 * BotActivityIndicator — rolling "current activity" line for the bot chat.
 *
 * Replaces the static loading bubble (BotTypingIndicator) at the bottom of
 * the transcript. The PILL ITSELF IS PERMANENT while the turn is busy —
 * only the inner content line changes, rolling upward: the old line slides
 * out the top while the new one slides in from below (two-phase grid-stack
 * animation). The bubble never disappears mid-turn; content swaps stay
 * continuous.
 *
 * Content semantics (kind → line):
 *   - thinking  → "正在思考" + the latest non-empty thinking line. Gated on
 *                 phase 'streaming' with no reply text: the thinking buffer
 *                 keeps the PREVIOUS block after a tool result, so showing
 *                 it in other phases would describe stale work.
 *   - tool      → semantic verb for the tool ("运行命令 / 读取文件 / 派出
 *                 子代理 …") + short input summary (command / file_path /
 *                 pattern / query …). Falls back to the title-cased name.
 *   - reply     → "正在回复" (the bot is streaming its message body)
 *   - waiting   → "等待确认" (permission card renders alongside)
 *   - error     → "遇到错误"
 *   - persisting→ "正在保存" (end-of-turn persistence window)
 *   - working   → neutral fallback while the turn is active but nothing
 *                 else has been reported yet.
 *
 * Driven by ONE subscription to the session stream snapshot (replayed on
 * mount) with signature dedupe. Render contract: the caller gates mounting
 * on `busy` (isStreaming || isFinalizing).
 */

import { useEffect, useRef, useState } from 'react';
import { streamSessionManager } from '@/lib/stream-session-manager';
import type { SessionStreamSnapshot, ToolUseInfo } from '@/types/message';

export type BotActivityKind = 'thinking' | 'tool' | 'reply' | 'waiting' | 'error' | 'working';

export interface BotActivity {
  kind: BotActivityKind;
  /** Primary label — semantic verb / "正在思考" / … */
  label: string;
  /** Optional secondary detail — thinking tail or tool input summary */
  detail?: string;
}

/** Stable identity of the current line: re-roll the animation when it flips. */
export function activityKey(a: BotActivity): string {
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

/** Semantic verb per tool — the line reads as what the bot is DOING. */
const TOOL_VERBS: Record<string, string> = {
  bash: '运行命令',
  read: '读取文件',
  edit: '编辑文件',
  multiedit: '编辑文件',
  write: '写入文件',
  glob: '查找文件',
  grep: '搜索内容',
  webfetch: '抓取网页',
  websearch: '搜索网页',
  task: '派出子代理',
  agent: '派出子代理',
  explore: '派出子代理',
  plan: '派出子代理',
  sendmessage: '发送消息',
  messagecolleague: '发送消息',
  todowrite: '更新任务清单',
  todo: '更新任务清单',
  askuserquestion: '向你提问',
  exitplanmode: '提交计划',
  notebookedit: '编辑 Notebook',
  workflow: '运行工作流',
  computer_use: '操作电脑',
  computer_use_decide: '操作电脑',
};

/** Semantic label for a tool call; unknown tools fall back to the name. */
export function toolLabel(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z_]/g, '');
  return TOOL_VERBS[key] ?? formatToolName(name);
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
 * Exported for tests. NEVER returns null — the pill is permanent while
 * mounted; unknown moments fall back to the neutral "正在处理" line.
 */
export function deriveBotActivity(snapshot: SessionStreamSnapshot): BotActivity {
  if (snapshot.error || snapshot.phase === 'error') {
    return { kind: 'error', label: '遇到错误' };
  }

  if (snapshot.phase === 'awaiting_permission') {
    return { kind: 'waiting', label: '等待确认', detail: '需要你批准后继续' };
  }

  const activeTool = findActiveTool(snapshot);
  if (activeTool) {
    const input = typeof activeTool.input === 'string'
      ? oneLine(activeTool.input)
      : summarizeToolInput(activeTool.input);
    return { kind: 'tool', label: toolLabel(activeTool.name), detail: input || undefined };
  }

  // Bot is streaming its reply body — the message itself is the activity.
  if (snapshot.streamingContent && snapshot.streamingContent.length > 0) {
    return { kind: 'reply', label: '正在回复' };
  }

  // Thinking tail, gated: the thinking buffer retains the PREVIOUS block
  // right after a tool result (phase still 'tool_use' / text not started),
  // and showing that would describe stale work. Only trust it while the
  // stream phase is actively streaming with no reply text yet.
  if (snapshot.phase === 'streaming' || snapshot.phase === 'starting') {
    const tail = thinkingTail(snapshot.streamingThinkingContent);
    if (tail) {
      return { kind: 'thinking', label: '正在思考', detail: tail };
    }
    return { kind: 'working', label: '正在处理' };
  }

  if (snapshot.phase === 'persisting') {
    return { kind: 'working', label: '正在保存' };
  }

  return { kind: 'working', label: '正在处理' };
}

const PREV_CLEAR_MS = 280;

export function BotActivityIndicator({ sessionId }: { sessionId: string }) {
  const [current, setCurrent] = useState<BotActivity | null>(null);
  const [prev, setPrev] = useState<BotActivity | null>(null);
  const currentRef = useRef<BotActivity | null>(null);
  const prevTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = streamSessionManager.subscribeSession(sessionId, (snapshot) => {
      const next = deriveBotActivity(snapshot);
      if (currentRef.current && activityKey(currentRef.current) === activityKey(next)) return;
      if (currentRef.current) {
        setPrev(currentRef.current);
        if (prevTimer.current) clearTimeout(prevTimer.current);
        prevTimer.current = setTimeout(() => setPrev(null), PREV_CLEAR_MS);
      }
      currentRef.current = next;
      setCurrent(next);
    });
    return () => {
      unsubscribe();
      if (prevTimer.current) clearTimeout(prevTimer.current);
    };
  }, [sessionId]);

  if (!current) return null;

  return (
    <div className={`bot-chat-activity bot-chat-activity--${current.kind}`} role="status" aria-live="polite">
      <span className="bot-chat-activity__spinner" aria-hidden="true" />
      <span className="bot-chat-activity__viewport">
        {prev && (
          <span key={`out-${activityKey(prev)}`} className="bot-chat-activity__line bot-chat-activity__line--out" aria-hidden="true">
            <span className="bot-chat-activity__label">{prev.label}</span>
            {prev.detail && <span className="bot-chat-activity__detail">{prev.detail}</span>}
          </span>
        )}
        <span key={activityKey(current)} className="bot-chat-activity__line bot-chat-activity__line--in">
          <span className="bot-chat-activity__label">{current.label}</span>
          {current.detail && <span className="bot-chat-activity__detail">{current.detail}</span>}
        </span>
      </span>
    </div>
  );
}
