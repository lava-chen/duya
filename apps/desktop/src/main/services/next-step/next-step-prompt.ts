import type { MessageRow } from '../../ipc/core-db-adapters';

const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 400;

/**
 * Build the prompt pair for next-step suggestion generation.
 *
 * Given the durable conversation rows of a finished session turn, produce
 * a system prompt describing the prediction task and a user content block
 * carrying a trimmed transcript. Pure function — unit-testable without
 * Electron or network access.
 */
export function buildNextStepPrompt(messages: MessageRow[]): {
  systemPrompt: string;
  userContent: string;
} {
  const transcript = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .map((m) => `[${m.role.toUpperCase()}]: ${trimContent(m.content || m.thinking || '(empty)', MAX_MESSAGE_CHARS)}`)
    .join('\n');

  const systemPrompt = `You predict the user's likely NEXT instruction at the end of a conversation between a user and an AI agent.

Propose EXACTLY 3 short follow-up prompts the user would most plausibly send next.

RULES:
- Each suggestion is written as if the USER typed it: imperative, direct. No quotes, no numbering, no emoji, no trailing punctuation.
- Match the conversation's language — a Chinese conversation gets Chinese suggestions.
- Keep each suggestion concise: under 30 Chinese characters or 12 English words.
- Make the three suggestions meaningfully different intents (for example: refine or extend the result, verify or test it, start a closely related step). Never repeat the same intent twice.
- Only suggest actions that are realistic given the conversation. Do not invent new requirements.

OUTPUT FORMAT:
STRICT JSON only, no markdown fences, no commentary: {"suggestions":["...","...","..."]}`;

  const userContent = `Conversation so far (oldest first, newest last):\n\n${transcript}\n\nPredict the 3 next-step prompts.`;

  return { systemPrompt, userContent };
}

/**
 * Parse the model's reply into at most 3 suggestion strings. Tolerates
 * markdown fences and surrounding chatter; returns [] on anything that
 * does not parse as {"suggestions": [...]}.
 */
export function parseNextStepSuggestions(raw: string | null): string[] {
  if (!raw) return [];
  let text = raw.trim();

  // Strip a ```json fence if the model added one despite instructions.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1].includes('{')) {
    text = fenceMatch[1].trim();
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { suggestions?: unknown };
    const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return list
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function trimContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + '...';
}
