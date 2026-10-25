/**
 * packages/host/src/worker-session/turn-suggestion.ts
 *
 * End-of-turn suggestion: predict the ONE follow-up prompt the user would
 * most plausibly type next.
 *
 * It runs in the worker right after a turn finishes, on the SAME model client
 * the turn itself used (`agent.readModelClient()`), so the suggestion costs
 * one short call and needs no provider configuration of its own.
 *
 * The shape follows Claude Code's prompt suggestion: one short suggestion, in
 * the user's voice, and silence when there is no obvious next step. Silence is
 * a real answer here — a wrong suggestion costs the user more attention than
 * no suggestion at all.
 */

import type { AIClient } from '@duya/ai';
import type { Message, MessageContent } from '@duya/agent-core/message';
import { getLogger } from '../worker-logger.js';

const SUGGESTION_TIMEOUT_MS = 8_000;
const MAX_SUGGESTION_CHARS = 60;
const MAX_CJK_SUGGESTION_CHARS = 20;
const MAX_TRANSCRIPT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 300;
const MIN_SUGGESTION_WORDS = 2;

const SUGGESTION_SYSTEM_PROMPT = `You predict what a user would type NEXT in a coding conversation with an AI agent.

FIRST: read the recent messages and the original request.

Your job is to predict what THEY would type — not what you think they should do.

THE TEST: would they think "I was just about to type that"?

Examples:
- User asked "fix the bug and run tests", bug is fixed -> "run the tests"
- Code was just written -> "try it out"
- The agent offered options -> suggest the one they would most likely pick
- The agent asked whether to continue -> "yes" or "go ahead"
- The task is done and the obvious next step exists -> "commit this" or "push it"

RULES:
- Write it as if the USER typed it: imperative, direct, first person optional.
- Match the conversation's language. A Chinese conversation gets Chinese.
- Keep it short: at most 12 English words, or at most 20 Chinese characters.
- Be specific: "run the tests" beats "continue".

NEVER output:
- Evaluative filler ("looks good", "thanks", "好的")
- A question ("what about...?")
- The agent's voice ("Let me...", "I'll...", "接下来我可以...")
- A brand new topic the user never mentioned
- More than one sentence

If there is no obvious next step, output exactly: NONE

Format: the suggestion only, no quotes, no numbering, no explanation.`;

/** What a turn produced: either a suggestion the user can accept, or nothing. */
export interface TurnSuggestionResult {
  readonly suggestion: string | null;
}

/**
 * Build the transcript block the model reads.
 *
 * Only user and assistant text is included: tool calls and reasoning blocks
 * are noise for "what would the user type next".
 */
export function buildTurnSuggestionInput(messages: readonly Message[]): string {
  const transcript = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .map((m) => {
      const content = trimContent(extractText(m) || '(empty)', MAX_MESSAGE_CHARS);
      return `[${m.role.toUpperCase()}]: ${content}`;
    })
    .join('\n');

  return `Conversation so far (oldest first, newest last):\n\n${transcript}\n\nPredict the next prompt the user would type.`;
}

/**
 * Turn the model's reply into a suggestion, or into nothing.
 *
 * The model is told to answer NONE when it has no idea, but a reasoning model
 * will often spell that out in prose ("there is no obvious next step") or
 * answer in the wrong voice. Those are filtered here rather than shown.
 */
export function parseTurnSuggestion(raw: string | null): string | null {
  if (!raw) return null;

  let text = raw.trim();
  if (!text) return null;

  // A model that answered in the wrong channel (thinking out loud) leaves
  // the answer buried; the first line is the one it meant to say.
  text = text.split(/\r?\n/)[0]!.trim();
  text = text.replace(/^["'「『（(\[]+/, '').replace(/["'」』）)\]]+$/, '').trim();
  text = text.replace(/^(?:next|prompt|suggestion|建议|下一句|下一步)\s*[:：]\s*/i, '').trim();

  if (!text) return null;

  const lower = text.toLowerCase();

  // The explicit "no idea" answers.
  if (lower === 'none' || lower === 'n/a' || lower === 'null' || lower === 'silence' || lower === '-') return null;
  if (/^(none|no|nothing|无|没有|暂无|不确定|n\/a)[.!。！]?$/.test(lower)) return null;

  // The model explained WHY it has no answer.
  if (
    lower.startsWith('no obvious next step') ||
    lower.startsWith('no clear next step') ||
    lower.startsWith('nothing to suggest') ||
    lower.startsWith('no suggestion') ||
    lower.startsWith('there is no obvious') ||
    lower.startsWith('没有明显的下一步') ||
    lower.startsWith('暂时没有') ||
    lower.startsWith('无法预测')
  ) {
    return null;
  }

  // The agent's own voice, not the user's.
  if (/^(let me|i'll|i've|i can|i would|i think|here's|here is|sure[,!]|sure\b|of course|certainly|我先|我来|让我|我可以|接下来我|下一步我)/i.test(text)) {
    return null;
  }

  // Evaluative filler is not a next action.
  if (/^(thanks|thank you|looks good|sounds good|that works|that's all|nice|great|perfect|好的|谢谢|不错|可以|行)$/i.test(lower)) {
    return null;
  }

  // Multi-sentence output is a paragraph, not a prompt.
  if (/[.!?。！？]\s+\S/.test(text)) return null;

  // Formatting means the model answered with structure, not a prompt.
  if (/[\n*`]/.test(text)) return null;

  if (text.length > MAX_SUGGESTION_CHARS) return null;

  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  if (cjkCount > 0) {
    if (text.length > MAX_CJK_SUGGESTION_CHARS) return null;
  } else {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < MIN_SUGGESTION_WORDS || words.length > 12) return null;
  }

  return text;
}

/**
 * Generate the suggestion for a finished turn.
 *
 * Fail-safe by contract: any error, timeout or unusable answer yields
 * `{ suggestion: null }` and never throws. A missing suggestion is a normal
 * outcome, not a failure.
 */
export async function generateTurnSuggestion(
  messages: readonly Message[],
  llmClient?: AIClient,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<TurnSuggestionResult> {
  if (!llmClient) return { suggestion: null };

  const assistantTurns = messages.filter((m) => m.role === 'assistant' && extractText(m).trim().length > 0);
  // One reply is not enough context to predict the next one.
  if (assistantTurns.length < 1) return { suggestion: null };

  const input = buildTurnSuggestionInput(messages);
  if (!input.trim()) return { suggestion: null };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUGGESTION_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const stream = llmClient.streamChat([{ role: 'user', content: input, timestamp: Date.now() }], {
      systemPrompt: SUGGESTION_SYSTEM_PROMPT,
      maxTokens: 60,
      temperature: 0.0,
      // The timeout has to reach the provider, or it only stops us waiting
      // while the request keeps running.
      signal: controller.signal,
    });

    let text = '';
    for await (const event of stream) {
      if (event.type === 'text') {
        text += event.data;
      } else if (event.type === 'error') {
        throw new Error(typeof event.data === 'string' ? event.data : 'suggestion call failed');
      }
    }

    return { suggestion: parseTurnSuggestion(text) };
  } catch (error) {
    getLogger().debug('Turn suggestion generation failed', {
      sessionId,
      errorName: error instanceof Error ? error.name : typeof error,
    }, 'TurnSuggestion');
    return { suggestion: null };
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

function extractText(message: Message): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is MessageContent & { text: string } =>
        typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block
      )
      .map((block) => block.text)
      .join(' ');
  }
  return '';
}

function trimContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + '...';
}
