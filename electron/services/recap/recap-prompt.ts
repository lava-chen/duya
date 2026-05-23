import type { MessageRow } from '../../db/queries/messages';

interface RecapMessages {
  role: string;
  content: string;
}

export function buildRecapPrompt(messages: MessageRow[]): {
  systemPrompt: string;
  userContent: string;
} {
  const filtered = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m): RecapMessages => ({
      role: m.role,
      content: m.content || m.thinking || '(empty)',
    }));

  const conversationLines = filtered
    .map((m) => `[${m.role.toUpperCase()}]: ${trimContent(m.content, 500)}`)
    .join('\n');

  const systemPrompt = `You are generating a ONE-SENTENCE recap for a user returning to their coding session after being away.

Focus on RECENT activity. The older messages are context — mention them only if directly relevant.

Your single sentence MUST cover:
1. What task the user was working on
2. Key files edited or created
3. Any pending task or unresolved issue

RULES:
- Output ONLY the recap sentence. No markdown, no quotes, no prefixes.
- Max 80 words.
- Use present continuous tense: "you were doing X"
- Be specific: name the files, tools, errors.
- Do NOT say "you were chatting about..." — describe the actual work.`;

  const userContent = `Here is the conversation history (oldest first, newest last):\n\n${conversationLines}`;

  return { systemPrompt, userContent };
}

function trimContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + '...';
}