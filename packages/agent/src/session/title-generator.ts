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
  const text = extractTextFromMessage(msg).trim().toLowerCase();
  // Check for common greeting patterns
  const meaninglessPatterns = [
    /^(hi|hello|你好|嗨|hey|yo|您好|hi\s*[,.!]*|hello\s*[,.!]*)\s*$/i,
    /^[\s,.!]*$/,
  ];
  return !meaninglessPatterns.some((p) => p.test(text));
}

const TITLE_GENERATION_PROMPT = `Generate a concise session title (3-7 Chinese words or 5-10 English words) that captures the main topic of this conversation.

Rules:
- Be specific but brief
- Use sentence case (capitalize only first word and proper nouns)
- No punctuation at the end
- No quotes
- Focus on the user's goal, not the assistant's response

Return ONLY the title text, no JSON, no explanation.`;

/**
 * Extract text content from messages for title generation input.
 * Skips system/meta messages and tool results. Takes the first user message
 * and first assistant response for context.
 */
function extractTitleInput(messages: readonly Message[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '';

  let text = extractTextFromMessage(firstUser).trim();
  if (!text) return '';

  if (text.length > MAX_INPUT_LENGTH) {
    text = text.slice(0, MAX_INPUT_LENGTH);
  }

  return `User: ${text}`;
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
 */
const CN_STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '什么', '怎么', '如何', '哪个',
  '这个', '那个', '这些', '那些', '可以', '需要', '应该', '能够', '可能',
  '因为', '所以', '但是', '不过', '虽然', '如果', '的话', '而且', '或者',
  '吧', '吗', '呢', '啊', '哦', '嗯', '哈', '呀', '嘛', '呗',
  '帮忙', '帮我', '请', '请问', '想问', '想问一下', '想问下',
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
 * Supports per-session tracking and topic drift detection.
 *
 * @param messages - Conversation messages
 * @param llmClient - LLM client for generation (optional)
 * @param signal - Abort signal for cancellation
 * @param sessionId - Session ID for per-session tracking (optional)
 * @param previousTitle - Previous title to check for topic drift (optional)
 * @returns Generated title or null
 */
export async function generateSessionTitle(
  messages: readonly Message[],
  llmClient?: LLMClient,
  signal?: AbortSignal,
  sessionId?: string,
  previousTitle?: string | null,
): Promise<{ title: string | null; shouldUpdate: boolean }> {
  // Always try heuristic first as fallback
  const fallback = generateHeuristicTitle(messages);

  // Check if first user message is meaningful
  const firstUser = messages.find((m) => m.role === 'user');
  const isMeaningful = isMeaningfulFirstMessage(firstUser ?? null);

  // If no LLM available, return heuristic immediately
  if (!llmClient) {
    return { title: fallback, shouldUpdate: isMeaningful };
  }

  // If first message is meaningless (like "hello"), skip LLM and use heuristic
  if (!isMeaningful) {
    console.log('[TitleGenerator] First message is not meaningful, skipping LLM generation');
    return { title: fallback, shouldUpdate: false };
  }

  const input = extractTitleInput(messages);
  if (!input.trim()) {
    return { title: fallback, shouldUpdate: true };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

    // Link external signal if provided
    if (signal) {
      signal.addEventListener('abort', () => controller.abort());
    }

    const stream = llmClient.streamChat(
      [
        { role: 'user', content: `${TITLE_GENERATION_PROMPT}\n\nConversation:\n${input}`, timestamp: Date.now() },
      ],
      {
        systemPrompt: 'You are a title generator. Respond with only the title, no other text.',
        maxTokens: 30,
        temperature: 0.3,
      },
    );

    let title = '';
    for await (const event of stream) {
      if (event.type === 'text') {
        title += event.data;
      } else if (event.type === 'error') {
        throw new Error(String(event.data));
      }
    }

    clearTimeout(timeoutId);

    title = title.trim().replace(/^["']|["']$/g, '').replace(/\n+/g, ' ');

    // Validate title quality
    if (title.length < TITLE_MIN_LENGTH || title.length > TITLE_MAX_LENGTH * 2) {
      return { title: fallback, shouldUpdate: true };
    }

    // Check topic drift if sessionId provided
    let shouldUpdate = true;
    if (sessionId && previousTitle) {
      shouldUpdate = !shouldRegenerateTitle(sessionId, messages, previousTitle);
      if (!shouldUpdate) {
        console.log('[TitleGenerator] Topic drift detected, will regenerate title');
      }
    }

    return { title, shouldUpdate };
  } catch (error) {
    // Silently fall back to heuristic - title generation is not critical
    if (process.env.DUYA_DEBUG_IPC === 'true') {
      console.log('[TitleGenerator] LLM generation failed, using heuristic:', error);
    }
    return { title: fallback, shouldUpdate: true };
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
