/**
 * Session title generator - lightweight, non-intrusive background title generation.
 *
 * Design principles:
 * 1. Lightweight: Minimal prompt, small maxTokens, only first user message as input
 * 2. Non-intrusive: Runs after the first assistant response completes, never blocks user input
 * 3. Fast: Single-shot prompt, minimal tokens, 10s timeout
 * 4. Just right length: 3-7 Chinese words or 5-10 English words
 * 5. Fail-safe: Any error falls back to intelligent heuristic extraction, user never notices
 */

import type { LLMClient } from '../llm/index.js';
import type { Message, MessageContent } from '../types.js';

const MAX_INPUT_LENGTH = 300;
const TITLE_MAX_LENGTH = 40;
const TITLE_MIN_LENGTH = 4;
const TITLE_TIMEOUT_MS = 10000; // 10s timeout, generous for slow models
const KEYWORD_OVERLAP_THRESHOLD = 0.4;
const DRIFT_CHECK_MIN_MESSAGES = 3;

/**
 * Per-session title generation state
 */
interface TitleState {
  generated: boolean;
  lastTitle?: string;
}

/**
 * Track title state per session (replaces global boolean)
 */
const titleStateBySession = new Map<string, TitleState>();

/**
 * Check if the session title should be regenerated due to topic drift.
 */
function shouldRegenerateTitle(
  sessionId: string,
  currentMessages: readonly Message[],
  previousTitle: string | null | undefined
): boolean {
  // Never generated before
  if (!previousTitle) {
    return false;
  }

  // Get recent user messages (last 3)
  const recentUserMsgs = currentMessages
    .filter((m) => m.role === 'user')
    .slice(-DRIFT_CHECK_MIN_MESSAGES);

  if (recentUserMsgs.length < 2) {
    return false;
  }

  // Extract keywords from text (Chinese: continuous chars >= 2, English: words >= 2)
  const extractKeywords = (text: string): Set<string> => {
    const matches = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{2,}/g) || [];
    return new Set(matches.map((w) => w.toLowerCase()));
  };

  const titleKeywords = extractKeywords(previousTitle);
  if (titleKeywords.size === 0) {
    return false;
  }

  const recentKeywords = new Set<string>();
  for (const msg of recentUserMsgs) {
    const text = extractTextFromMessage(msg);
    extractKeywords(text).forEach((k) => recentKeywords.add(k));
  }

  // Calculate overlap ratio
  const overlap = [...titleKeywords].filter((k) => recentKeywords.has(k)).length;
  const ratio = overlap / titleKeywords.size;

  if (ratio < KEYWORD_OVERLAP_THRESHOLD) {
    console.log(`[TitleGenerator] Topic drift detected: overlap=${ratio.toFixed(2)}, threshold=${KEYWORD_OVERLAP_THRESHOLD}`);
    return true;
  }

  return false;
}

/**
 * Check if the first user message is meaningful enough to generate a title.
 */
function isMeaningfulFirstMessage(msg: Message | null): boolean {
  if (!msg) {
    return false;
  }
  const text = extractTextFromMessage(msg).trim();
  // Only consider it meaningless if it's JUST a greeting (no other content)
  // Pattern matches: standalone greetings with optional punctuation, but nothing else
  const standaloneGreetingPattern = /^(?:hi|hello|你好|嗨|hey|yo|您好)[\s,.!]*$/i;
  const emptyPattern = /^[\s,.!]*$/;
  return !standaloneGreetingPattern.test(text) && !emptyPattern.test(text);
}

/** Max characters for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_CHARS = 12;
/** Max words for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_WORDS = 2;

/**
 * Check if text looks like LLM preamble.
 * Matches: "Title", "Topic", "Sure", "Sure, the title is", "Here's the topic", etc.
 */
function isPreamblePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  // Exact single-word preamble
  if (/^(?:title|topic|sure|okay|ok)$/.test(lower)) return true;
  // Starts with a known opener and optionally references title/topic
  if (/^(?:sure|okay|ok|here(?:'s| is))\b/.test(lower)) return true;
  // "the title/topic is" or similar
  if (/^the\s+(?:title|topic)\b/.test(lower)) return true;
  return false;
}

/**
 * Check if a message is likely low-signal (short acknowledgement/command).
 * Language-agnostic: uses length + word count only.
 */
function isLowSignal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > LOW_SIGNAL_MAX_CHARS) return false;
  if (trimmed.split(/\s+/).length > LOW_SIGNAL_MAX_WORDS) return false;
  // If it contains a question mark, it's probably a real question
  if (trimmed.includes('?')) return false;
  return true;
}

/**
 * Select a spread of user messages that captures the session's purpose:
 * first (original intent), a recent-biased middle, and last (current state).
 */
function selectSpreadMessages(allUserMessages: string[]): string[] {
  const count = allUserMessages.length;
  if (count === 0) return [];

  // Strip trailing low-signal messages
  let filtered = allUserMessages;
  let trimEnd = allUserMessages.length;
  while (trimEnd > 0 && isLowSignal(allUserMessages[trimEnd - 1]!)) {
    trimEnd--;
  }
  if (trimEnd > 0) {
    filtered = allUserMessages.slice(0, trimEnd);
  }
  // else: all messages are low-signal, keep original array

  const n = filtered.length;
  if (n === 1) return [filtered[0]!];
  if (n === 2) return [filtered[0]!, filtered[1]!];
  if (n === 3) return [filtered[0]!, filtered[1]!, filtered[2]!];

  const midIndex = Math.floor(n * 2 / 3);
  return [filtered[0]!, filtered[midIndex]!, filtered[n - 1]!];
}

/**
 * Validate and clean a generated title.
 * Iteratively strips known LLM preamble artifacts and checks length bounds.
 */
function validateTitle(title: string | null | undefined): string | null {
  if (!title) return null;

  let cleaned = title.trim();

  // Reject known bad responses that are not valid titles
  const badResponses = [
    'the user',
    'the user:',
    'user',
    'question',
    'help',
    'problem',
    '聊天',
    '对话',
    '问题',
    '标题',
  ];
  const lowerCleaned = cleaned.toLowerCase();
  if (badResponses.includes(lowerCleaned)) {
    console.log(`[TitleGenerator] validateTitle: rejected bad response "${cleaned}"`);
    return null;
  }

  // Iterative preamble stripping: handles chained preambles like "Sure: Title: Foo"
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    const colonIndex = cleaned.indexOf(':');
    if (colonIndex > 0 && colonIndex < 40) {
      const beforeColon = cleaned.slice(0, colonIndex);
      if (isPreamblePrefix(beforeColon)) {
        cleaned = cleaned.slice(colonIndex + 1).trim();
      }
    }
  }

  // Strip surrounding quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }

  // Strip surrounding bold markers **title**
  if (cleaned.startsWith('**') && cleaned.endsWith('**')) {
    cleaned = cleaned.slice(2, -2);
  }

  // Strip leading markdown heading markers (one or more #, -, *)
  cleaned = cleaned.replace(/^[#\-*]+\s+/, '');

  cleaned = cleaned.trim();

  // Reject empty, too long, or too many words (likely preamble leakage)
  const MAX_TITLE_WORDS = 10;
  if (cleaned.length === 0 || cleaned.length >= 100) return null;
  if (cleaned.split(/\s+/).length > MAX_TITLE_WORDS) return null;

  // Final check for bad responses after cleaning
  if (badResponses.includes(cleaned.toLowerCase())) {
    console.log(`[TitleGenerator] validateTitle: rejected after cleaning "${cleaned}"`);
    return null;
  }

  return cleaned;
}

const TITLE_GENERATION_PROMPT = `CRITICAL: You must output ONLY a JSON object, no explanations or thinking.

Correct output examples:
{"title":"纽博格林耐力赛新闻"}
{"title":"trendradar开源项目搜索"}

INCORRECT outputs (will be rejected):
- "Let me think about this..." ❌
- "Based on the conversation..." ❌
- "The title is: ..." ❌
- "Here is the JSON: ..." ❌

Rules:
1. Chinese conversation → Chinese title
2. 4-6 words maximum
3. NEVER write explanations, only the JSON

Output now:

Conversation:
`;

/**
 * Extract text content from messages for title generation input.
 * Uses first 10 messages (5 rounds) to capture session purpose.
 * Filters out tool result content and low-signal messages.
 */
function extractTitleInput(messages: readonly Message[]): string {
  // Take first 10 messages (5 rounds of user-assistant) to capture full context
  const recentMessages = messages.slice(0, 10);
  console.log(`[TitleGenerator] extractTitleInput: processing ${recentMessages.length} messages`);

  const formattedMessages: string[] = [];
  for (const msg of recentMessages) {
    const text = extractTextFromMessage(msg).trim();
    if (!text) continue;

    // Skip very short or low-signal messages at the end
    if (msg.role === 'user' && formattedMessages.length >= 4 && isLowSignal(text)) {
      console.log(`[TitleGenerator] Skipping low-signal message: "${text}"`);
      continue;
    }

    // Truncate very long content (tool output, etc.)
    const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
    const prefix = msg.role === 'user' ? 'User' : 'Assistant';
    formattedMessages.push(`${prefix}: ${truncated}`);
  }

  const result = formattedMessages.join('\n');
  console.log(`[TitleGenerator] extractTitleInput result (${formattedMessages.length} messages):\n${result.substring(0, 500)}...`);
  return result;
}

function extractTextFromMessage(msg: Message): string {
  const content = msg.content;
  if (typeof content === 'string') {
    return content;
  }
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

/**
 * Chinese stop words to filter out when extracting key phrases.
 * Only single-character function words - multi-char prefixes are handled by regex in extractChineseTopic.
 */
const CN_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '什么', '怎么', '如何', '哪个',
  '这个', '那个', '这些', '那些', '可以', '需要', '应该', '能够', '可能',
  '因为', '所以', '但是', '不过', '虽然', '如果', '的话', '而且', '或者',
  '吧', '吗', '呢', '啊', '哦', '嗯', '哈', '呀', '嘛', '呗',
  '请',
]);

/**
 * Extract a concise topic phrase from a Chinese text.
 * Splits by punctuation and finds the most informative segment.
 */
function extractChineseTopic(text: string): string | null {
  const segments = text
    .split(/[，。！？；：、\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);

  if (segments.length === 0) return null;

  // Remove common prefixes from each segment
  const cleaned = segments.map((s) =>
    s.replace(/^(我想|我需要|我要|我想问|我想知道|请问|想问一下|想问下|帮忙|帮我看|帮我)\s*/i, '')
  );

  // Score segments by informativeness: fewer stop words = more informative
  const scored = cleaned.map((seg, idx) => {
    if (seg.length === 0) return { seg, score: -999, idx };
    const chars = [...seg];
    const contentChars = chars.filter((c) => !CN_STOP_WORDS.has(c));
    const ratio = contentChars.length / chars.length;
    // Prefer segments that start with key content (not function words)
    const startsWithContent = contentChars.length > 0 && chars[0] === contentChars[0];
    return { seg, score: ratio * seg.length + (startsWithContent ? 2 : 0), idx };
  });

  scored.sort((a, b) => b.score - a.score);

  // Take the best segment, but prefer first if scores are close
  const best = scored[0];
  if (best.score <= 0) return null;

  // If there's a close second segment, try combining
  const TARGET_MAX = 20;
  if (best.seg.length < TARGET_MAX - 5 && scored.length > 1 && scored[1].score > best.score * 0.6) {
    // Sort back by original order
    const candidates = [best, scored[1]].sort((a, b) => a.idx - b.idx);
    const combined = candidates.map((c) => c.seg).join('，');
    if (combined.length <= TARGET_MAX) return combined;
  }

  return best.seg.length > TARGET_MAX ? best.seg.slice(0, TARGET_MAX) : best.seg;
}

/**
 * Heuristic title extraction when LLM is unavailable or fails.
 * For Chinese: extracts the most informative topic phrase.
 * For English: takes the first sentence, cleaned.
 */
export function generateHeuristicTitle(messages: readonly Message[]): string | null {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return null;

  let text = extractTextFromMessage(firstUser).trim();
  if (!text) return null;

  // Remove common prefixes
  text = text
    .replace(/^(请|帮忙|帮我|能不能|能否|可以|请帮我|能否帮我|我想|我需要|我要|我想问|我想知道|请问|想问一下|想问下)\s*/i, '')
    .replace(/^(please\s+|can\s+you\s+|could\s+you\s+|help\s+me\s+|i\s+want\s+to\s+|i\s+need\s+to\s+|how\s+do\s+i\s+|how\s+to\s+)/i, '');

  const isChinese = /[\u4e00-\u9fa5]/.test(text);

  if (isChinese && text.length > 15) {
    const topic = extractChineseTopic(text);
    if (topic && topic.length >= 4 && topic.length <= 30) {
      return topic;
    }
  }

  // Fallback: truncate to reasonable length
  if (text.length > TITLE_MAX_LENGTH) {
    text = text.slice(0, TITLE_MAX_LENGTH);
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace > TITLE_MIN_LENGTH) {
      text = text.slice(0, lastSpace);
    }
    text = text + '...';
  }

  return text || null;
}

/**
 * Generate a session title using LLM with fallback to heuristic.
 *
 * @param messages - Conversation messages
 * @param llmClient - LLM client for generation (optional)
 * @param signal - Abort signal for cancellation
 * @param sessionId - Session ID for logging (optional)
 * @returns Generated title or null
 */
export async function generateSessionTitle(
  messages: readonly Message[],
  llmClient?: LLMClient,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<{ title: string | null }> {
  console.log(`[TitleGenerator] Called with ${messages.length} messages, sessionId=${sessionId}, hasLLM=${!!llmClient}`);

  // Always try heuristic first as fallback
  const fallback = generateHeuristicTitle(messages);
  console.log(`[TitleGenerator] Heuristic fallback: "${fallback}"`);

  // Check if there are any meaningful user messages (not just greetings)
  const allUserMessages = messages.filter((m) => m.role === 'user');
  const meaningfulUserMessages = allUserMessages.filter((m) => isMeaningfulFirstMessage(m));
  const hasMeaningfulContent = meaningfulUserMessages.length > 0;
  const firstUser = allUserMessages[0];
  console.log(`[TitleGenerator] Total user messages: ${allUserMessages.length}, meaningful: ${meaningfulUserMessages.length}`);
  console.log(`[TitleGenerator] First user message: "${firstUser?.content?.toString().substring(0, 50)}", isMeaningful=${isMeaningfulFirstMessage(firstUser ?? null)}`);

  // If no LLM available, return heuristic immediately
  if (!llmClient) {
    console.log('[TitleGenerator] No LLM client, returning heuristic');
    return { title: fallback };
  }

  // Only skip if ALL user messages are greetings or empty
  // If there's any meaningful content, continue to LLM generation
  if (!hasMeaningfulContent) {
    console.log('[TitleGenerator] No meaningful user messages found, using heuristic fallback');
    return { title: fallback };
  }

  const input = extractTitleInput(messages);
  console.log('[TitleGenerator] extractTitleInput returned:', input.substring(0, 100) + '...');
  if (!input.trim()) {
    console.log('[TitleGenerator] Input is empty after trim, returning fallback');
    return { title: fallback };
  }

  try {
    console.log('[TitleGenerator] About to call streamChat with LLM client');
    console.log('[TitleGenerator] Input preview:', input.substring(0, 200));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

    const onExternalAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      console.log('[TitleGenerator] Creating stream with LLM client');
      const stream = llmClient.streamChat(
        [
          { role: 'user', content: `${TITLE_GENERATION_PROMPT}${input}`, timestamp: Date.now() },
        ],
        {
          systemPrompt: 'You are a title generator. Output ONLY JSON, no explanations.',
          maxTokens: 50,
          temperature: 0.3,
        },
      );

      let title = '';
      let eventCount = 0;
      let thinkingContent = '';
      for await (const event of stream) {
        eventCount++;
        if (event.type === 'text') {
          title += event.data;
          console.log(`[TitleGenerator] Stream event ${eventCount}: type=text, text length=${event.data.length}`);
        } else if (event.type === 'thinking') {
          // MiniMax wraps response in <think> tags - extract JSON from thinking if text is empty
          thinkingContent += typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
          console.log(`[TitleGenerator] Stream event ${eventCount}: type=thinking, len=${thinkingContent.length}`);
        } else if (event.type === 'done') {
          console.log(`[TitleGenerator] Stream event ${eventCount}: type=done`);
        } else if (event.type === 'error') {
          console.log(`[TitleGenerator] Stream event ${eventCount}: type=error, message=${event.data}`);
          throw new Error(event.data);
        } else {
          console.log(`[TitleGenerator] Stream event ${eventCount}: type=${event.type} (ignored)`);
        }
      }
      console.log(`[TitleGenerator] Stream iteration done, eventCount=${eventCount}, title_len=${title.length}, thinking_len=${thinkingContent.length}`);

      clearTimeout(timeoutId);

      // Try to parse JSON from text, then from thinking content
      let cleanedTitle: string | null = null;
      for (const source of [title, thinkingContent]) {
        if (cleanedTitle) break;
        try {
          const jsonMatch = source.match(/\{[^}]*\}/s);
          console.log(`[TitleGenerator] JSON match attempt: source=${source === title ? 'text' : 'thinking'}, matched=${!!jsonMatch}`);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]!);
            if (parsed.title && typeof parsed.title === 'string') {
              cleanedTitle = validateTitle(parsed.title);
              console.log(`[TitleGenerator] JSON parsed from ${source === title ? 'text' : 'thinking'}, title="${cleanedTitle}"`);
            } else {
              console.log(`[TitleGenerator] JSON matched but no valid title field: keys=${Object.keys(parsed)}`);
            }
          }
        } catch (e) {
          console.log(`[TitleGenerator] JSON parse failed for ${source === title ? 'text' : 'thinking'}: ${e instanceof Error ? e.message : String(e)}, content_len=${source.length}`);
        }
      }

      if (!cleanedTitle) {
        console.log('[TitleGenerator] Title validation failed, using heuristic fallback');
        return { title: fallback };
      }
      title = cleanedTitle;

      console.log(`[TitleGenerator] LLM generated title: "${title}", fallback: "${fallback}"`);
      return { title };
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  } catch (error) {
    // Silently fall back to heuristic - title generation is not critical
    console.log('[TitleGenerator] LLM generation failed, using heuristic:', error instanceof Error ? error.message : String(error));
    return { title: fallback };
  }
}

/**
 * Get title state for a session
 */
export function getTitleState(sessionId: string): TitleState | undefined {
  return titleStateBySession.get(sessionId);
}

/**
 * Update title state for a session
 */
export function setTitleState(sessionId: string, state: TitleState): void {
  titleStateBySession.set(sessionId, state);
}

/**
 * Clear title state for a session (call when session is closed/deleted)
 */
export function clearTitleState(sessionId: string): void {
  titleStateBySession.delete(sessionId);
}
