/**
 * packages/agent/src/agent/tool-intent-detector.ts
 *
 * Plan 418 L2 — tool-intent / action-consistency check.
 *
 * Third-party models (e.g. deepseek-v4-flash via the DeepSeek /anthropic
 * compat surface) occasionally end a turn by *announcing* a tool action
 * ("let me read the config", "让我修改这个文件") without ever emitting the
 * corresponding `tool_use` block. The harness then finalizes the turn and
 * the user sees the agent "stop halfway".
 *
 * This detector recognizes strong tool-intent statements in the LAST
 * non-empty paragraph of the turn-final assistant text and lets the turn
 * logic inject a continuation nudge (same pattern as the goal
 * premature-stop detector / dead-loop nudge).
 *
 * Deliberately conservative: the matcher requires a first-person intent
 * phrase AND an action verb within a bounded span on the same paragraph.
 * Routine work narration ("Once the tests settle I'll iterate") does not
 * carry both signals and is ignored.
 */

export const TOOL_INTENT_PATTERNS = [
  'read',
  'modify',
  'run',
  'search',
  'other',
] as const;

export type ToolIntent = (typeof TOOL_INTENT_PATTERNS)[number];

/** First-person intent phrases (EN + ZH), in priority order. */
const INTENT_PHRASE =
  /(?:let me|i(?:'ll| will|'m going to| need to| should| want to|'d like to| am going to)|让我|我来|我先|接下来|现在|我准备|我将|我要|我需要|我打算|先让我|让我先)/i;

/** Action verbs that indicate an actual tool-usable operation. English verbs
 *  use \b word boundaries; CJK verbs must not (CJK chars are not word chars). */
const ACTION_VERB =
  /\b(?:read|open|check|inspect|look at|run|execute|start|launch|modify|edit|change|update|write|append|create|install|configure|set up|setup|search|query|find|explore|verify|test|list|cat|grep|glob)\b|(?:读取|查看|检查|运行|执行|启动|修改|编辑|更新|写入|创建|安装|配置|设置|搜索|查询|查找|探索|验证|测试|列出|打开|继续)/i;

/** Bounded gap between the intent phrase and the action verb. */
const INTENT_ACTION_SPAN = 40;

function classifyAction(action: RegExpExecArray | null): ToolIntent {
  const verb = (action?.[0] ?? '').toLowerCase();
  if (/read|open|check|inspect|look at|查看|读取|检查|打开|列出/.test(verb)) return 'read';
  if (/modify|edit|change|update|write|append|create|修改|编辑|更新|写入|创建/.test(verb)) return 'modify';
  if (/run|execute|start|launch|运行|执行|启动/.test(verb)) return 'run';
  if (/search|query|find|explore|搜索|查询|查找|探索/.test(verb)) return 'search';
  return 'other';
}

/**
 * Detect a strong tool-intent statement in the LAST non-empty paragraph of
 * `text` (mirrors the goal-stop-detector's paragraph rule: only the
 * turn-final paragraph is judged). Returns the intent label, or undefined
 * when no credible intent+action pair is present.
 */
export function matchedToolIntent(text: string | undefined | null): ToolIntent | undefined {
  if (!text) return undefined;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const last = paragraphs[paragraphs.length - 1];
  if (!last) return undefined;

  const intentIdx = last.search(INTENT_PHRASE);
  if (intentIdx === -1) return undefined;

  const after = last.slice(intentIdx + 1);
  const action = ACTION_VERB.exec(after);
  if (!action) return undefined;

  // The action verb must be within a bounded span of the intent phrase.
  if (action.index > INTENT_ACTION_SPAN) return undefined;

  return classifyAction(action);
}

/** Continuation nudge injected when a tool intent never materialized. */
export function toolIntentNudge(intent: ToolIntent): string {
  const verbLabel: Record<ToolIntent, string> = {
    read: 'read/inspect files',
    modify: 'modify or write files',
    run: 'execute a command or script',
    search: 'search or query',
    other: 'act with a tool',
  };
  return (
    `You stated an intent to ${verbLabel[intent]} but the turn ended without a tool call. ` +
    'Continue now: emit the actual tool_use block and follow through. Only stop when the work ' +
    'is genuinely complete or you explicitly explain why it cannot proceed.'
  );
}
