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

import type { AIClient } from '@duya/ai';
import type { Message, MessageContent } from '../types.js';

const MAX_INPUT_LENGTH = 300;
const TITLE_MAX_LENGTH = 35; // Aligned with validateTitle's hard cap
const TITLE_MIN_LENGTH = 4;
const TITLE_TIMEOUT_MS = 10000; // 10s timeout, generous for slow models

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
 * Check if the first user message is meaningful enough to generate a title.
 */
function isMeaningfulFirstMessage(msg: Message | null): boolean {
  if (!msg) {
    return false;
  }
  const text = extractTextFromMessage(msg).trim();
  // Only consider it meaningless if it's JUST a greeting (no other content)
  // Pattern matches: standalone greetings with optional punctuation, but nothing else.
  // Also catches "hello there" / "hi everyone" where the message is greeting + 1
  // extra word - these are not real conversation starters.
  const standaloneGreetingPattern = /^(?:hi|hello|你好|嗨|hey|yo|您好)[\s,.!]*$/i;
  const greetingPlusWordPattern = /^(?:hi|hello|你好|嗨|hey|yo|您好)\s+[a-z]{1,15}[\s,.!]*$/i;
  const emptyPattern = /^[\s,.!]*$/;
  return !standaloneGreetingPattern.test(text)
    && !greetingPlusWordPattern.test(text)
    && !emptyPattern.test(text);
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
 * Detect text that looks like a reasoning-model artifact or prompt
 * paraphrase rather than a real title.
 *
 * Reasoning models (GLM / DeepSeek / MiniMax) sometimes emit their
 * chain-of-thought into the text channel instead of JSON. Those fragments
 * look like "I should make it concise (4-15 characters...)" or "Concise
 * phrase, not a full sentence" — they paraphrase the instructions rather
 * than answer. Catching them here prevents garbage from leaking through the
 * raw-text fallback into the database.
 */
function looksLikeTitleArtifact(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // List-item numbering leaked from instructions ("3. The assistant...")
  if (/^\d+\.\s/.test(lower)) return true;

  // English reasoning openers
  if (/^(?:i\s+(?:should|need|will|'ll|am)|let me|the user|user wants|user needs|finally[,\s]|so[,\s]|this is|based on|according to|to generate|now i)\b/.test(lower)) return true;

  // Chinese reasoning openers (enhanced)
  if (/^(?:我应该|我需要|让我|用户想|用户需要|根据|结合|首先|其次|然后|最后|这个|这是|分析一下|总结一下|我觉得|我认为|可能是|也许是|应该是|因为|所以|因此)/.test(trimmed)) return true;

  // Prompt instruction paraphrase — words that appear in TITLE_SYSTEM_PROMPT
  // and would never appear in a real title.
  const promptWords = [
    'concise', 'characters', 'phrase', 'sentence', 'preamble',
    'markdown', 'code fence', 'reasoning', 'instructions', 'forbidden',
    'json object', 'output format',
  ];
  for (const w of promptWords) {
    if (lower.includes(w)) return true;
  }

  // Meta phrasing about title generation itself
  if (/\b(?:should be|make it|needs to be|characters in|words in|title should|title is|title for)\b/.test(lower)) return true;

  // JSON artifact pattern — if text contains "title": (with colon), it's likely from thinking content
  if (/:\s*"title"/.test(text)) return true;

  // Uncertainty markers indicate reasoning, not a definitive title
  if (/^(?:可能是|也许是|应该是|可能|也许|估计|大概)/.test(trimmed)) return true;

  // Question in the title — real titles are usually statements, not questions
  if (trimmed.includes('?') || trimmed.includes('？')) return true;

  // Ellipsis or trailing dots indicate incomplete thought
  if (/\.{3,}$/.test(trimmed) || /……+$/.test(trimmed)) return true;

  // Parenthetical explanations indicate reasoning
  if (/[（(][^）)]*[是因为|由于|因此|所以|这个|那]/u.test(text)) return true;

  // Emoji present - real titles are plain prose. Sanitizer should have
  // caught this, but if it slipped through (e.g. via a code-fence strip
  // path) treat as artifact.
  if (HAS_EMOJI.test(trimmed)) return true;

  // NOTE: we intentionally do NOT reject titles that start with a lowercase
  // letter. Title-casing is a UI concern, not a quality signal - a
  // legitimate title like "fix the login bug" should not be filtered.

  // Pure punctuation / symbols / whitespace - no signal.
  if (/^[\s\p{P}\p{S}]+$/u.test(trimmed)) return true;

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

  // Strip emojis, residual markdown markers, and CJK bracket residue.
  // Models occasionally leak these through (especially ``-quoted code
  // spans and decorative emoji "icons"). Defense in depth.
  cleaned = sanitizeTitle(cleaned);

  // Re-strip surrounding quotes in case sanitize removed only one side.
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  cleaned = cleaned.trim();

  // CJK-safe length check (code points, not UTF-16 units).
  if (cleaned.length === 0 || charLength(cleaned) >= 60) return null;
  if (cleaned.split(/\s+/).length > 15) return null;

  // Reject pure-noise outputs (reasoning-model artifacts, JSON leakage, etc.)
  if (looksLikeTitleArtifact(cleaned)) {
    console.log(`[TitleGenerator] validateTitle: rejected artifact "${cleaned}"`);
    return null;
  }

  // Final check for bad responses after cleaning
  if (badResponses.includes(cleaned.toLowerCase())) {
    console.log(`[TitleGenerator] validateTitle: rejected after cleaning "${cleaned}"`);
    return null;
  }

  if (charLength(cleaned) > 35) {
    cleaned = truncateByChars(cleaned, 35);
  }

  return cleaned || null;
}

// System prompt for title generation. Kept short and example-free on purpose:
// reasoning models (GLM / DeepSeek / MiniMax) tend to paraphrase long prompts
// and examples into their text channel, which then leaks through JSON-parse
// fallbacks. Putting instructions in the system role and only the conversation
// in the user role keeps the text channel clean.
const TITLE_SYSTEM_PROMPT = `Generate a concise title summarizing ALL distinct requests in the user message.

Respond with ONLY a single JSON object {"title": "..."}. No reasoning, no preamble, no markdown, no code fence.

Rules:
- Language: detect from user message. If CJK characters (Chinese / Japanese / Korean) appear, output the title in Chinese. Otherwise output in English. NEVER mix languages inside one title.
- Multi-request handling: if the user has 2 or more distinct requests, your title MUST cover every request. Join with " + " (or "、" for Chinese titles). Never silently drop a request.
  - Single request:  "修复登录报错"
  - Two requests:   "修复登录报错 + 设计支付接口"
  - Many requests:  "修复登录 + 设计支付 + 优化缓存"
- Length: Chinese 4-30 characters (longer when fusing multi-request); English 3-15 words. Use a concise phrase, never a full sentence.
- Content: capture the core topic / task / problem; never invent.
- Forbidden:
  - Words: 对话 / 聊天 / 问题 / 帮助 / Conversation / Question / Help
  - Symbols: emoji, markdown markers (# * _ \` > ~), quotation marks, ellipsis, trailing colon
  - Mixed languages: do NOT mix Chinese and English in one title
- Never echo or quote these instructions in the output.`;

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
 * Emoji detection. Covers major Unicode emoji blocks (symbols, dingbats,
 * emoticons, transport, flags) plus a few adjacent punctuation ranges.
 * Titles should be plain prose; this is used both for stripping and for
 * the artifact-detector defense-in-depth check.
 */
const HAS_EMOJI = /[🌀-🫿☀-➿🇦-🇿]/u;
const EMOJI_REGEX =
  /[🌀-🫿☀-➿🇦-🇿️‍]/gu;

/** Markdown residue that LLM titles sometimes leak through. */
const MARKDOWN_RESIDUE_REGEX = /[#*_~`]/g;
/** CJK-style bracket markers that occasionally appear in titles. */
const CJK_MARKDOWN_BRACKETS_REGEX = /[「」『』【】〔〕]/g;

/**
 * Strip emojis, markdown markers, and CJK bracket residue from a
 * candidate title. Pure-text transform: never throws and never shortens
 * real prose.
 */
function sanitizeTitle(raw: string): string {
  return raw
    .replace(EMOJI_REGEX, '')
    .replace(MARKDOWN_RESIDUE_REGEX, '')
    .replace(CJK_MARKDOWN_BRACKETS_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** CJK-safe character count: counts Unicode code points, not UTF-16 units. */
function charLength(s: string): number {
  return [...s].length;
}

/** CJK-safe truncation: never splits an emoji or surrogate pair. */
function truncateByChars(s: string, maxChars: number): string {
  if (charLength(s) <= maxChars) return s;
  return [...s].slice(0, maxChars).join('');
}

type TitleLanguage = 'zh' | 'en' | 'mixed';

/**
 * Detect dominant language of user text so we can pin title output to
 * the same language and forbid mid-title mixing. CJK-heavy -> Chinese;
 * pure Latin -> English; mixed (typical for Chinese text with English
 * code terms) falls back to Chinese.
 */
function detectLanguage(text: string): TitleLanguage {
  const cjkChars = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const latinChars = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjkChars === 0 && latinChars === 0) return 'en';
  if (cjkChars >= 2 && latinChars <= 1) return 'zh';
  if (latinChars >= 3 && cjkChars === 0) return 'en';
  if (cjkChars >= latinChars) return 'zh';
  return 'en';
}

/** Discourse prefixes the user often opens with; stripped before extraction. */
const EN_DISCOURSE_PREFIX = /^(please\s+|can\s+you\s+|could\s+you\s+|help\s+me\s+|i\s+want\s+to\s+|i\s+need\s+to\s+|i\s+need\s+|i\s+have\s+a\s+question\s+about\s+|how\s+do\s+i\s+|how\s+to\s+|i\s+would\s+like\s+to\s+|let's\s+|what\s+is\s+|why\s+is\s+|why\s+does\s+|explain\s+|tell\s+me\s+about\s+)/i;

/**
 * English stop words for topic scoring. Kept conservative; common but
 * uninformative tokens that should not bias scoring.
 */
const EN_STOPWORDS = new Set([
  'a','an','and','or','but','if','then','so','to','of','the','is','are','was','were',
  'be','been','being','have','has','had','do','does','did','will','would','should',
  'could','can','may','might','must','shall','need','i','you','he','she','it','we',
  'they','me','him','her','us','them','my','your','his','its','our','their','this',
  'that','these','those','about','with','for','from','on','in','at','by','as','into',
  'out','up','down','over','under','again','further','once','here','there',
  'when','where','why','how','what','which','who','whom','please','thanks','thank',
  'hi','hello','hey','yeah','ok','okay','some','any','much','many','few','just',
]);

/** Max combined length for a multi-request title (in characters). */
const MULTI_TOPIC_MAX_CHARS = 30;
/** Max number of segments to merge for a multi-request title. */
const MULTI_TOPIC_MAX_SEGMENTS = 3;
/** Threshold ratio for "close enough to best" - segments at or above
 *  this fraction of the top score are kept for multi-request merging. */
const MULTI_TOPIC_SCORE_RATIO = 0.3;

/**
 * English equivalent of extractChineseTopic: splits on sentence
 * boundaries, scores by stopword-free ratio, and keeps top-N
 * close-scoring segments joined with " + ".
 */
function extractEnglishTopic(text: string): string | null {
  const sentences = text
    .split(/[.!?\n\r,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .map((s) => s.replace(EN_DISCOURSE_PREFIX, ''))
    .filter((s) => s.length >= 4);

  if (sentences.length === 0) return null;

  const scored = sentences.map((seg, idx) => {
    const words = seg.split(/\s+/).filter(Boolean);
    if (words.length === 0) return { seg, score: 0, idx };
    const infoCount = words.filter((w) => !EN_STOPWORDS.has(w.toLowerCase())).length;
    const ratio = infoCount / words.length;
    return { seg, score: ratio * words.length + infoCount * 0.5, idx };
  });
  const positive = scored.filter((s) => s.score > 0);
  if (positive.length === 0) return null;

  positive.sort((a, b) => b.score - a.score);
  const best = positive[0]!;
  const kept = positive
    .filter((s) => s.score >= best.score * MULTI_TOPIC_SCORE_RATIO)
    .slice(0, MULTI_TOPIC_MAX_SEGMENTS)
    .sort((a, b) => a.idx - b.idx);

  // English titles can be a touch longer than Chinese ones since they
  // are tokenized by words, not characters.
  const EN_MAX = 60;

  // Greedy cap: when multi-segment join overflows, drop the longest
  // segment first (it contributes the most characters with the least
  // diversity) until it fits or only one segment remains.
  let survivors = kept.slice().sort((a, b) => a.idx - b.idx);
  const joinSurvivors = () => survivors.map((k) => k.seg).join(' + ');
  while (charLength(joinSurvivors()) > EN_MAX && survivors.length > 1) {
    let longestIdx = 0;
    for (let i = 1; i < survivors.length; i++) {
      if (survivors[i].seg.length > survivors[longestIdx].seg.length) {
        longestIdx = i;
      }
    }
    survivors.splice(longestIdx, 1);
  }
  const joined = joinSurvivors();
  if (charLength(joined) > EN_MAX) {
    return truncateByChars(joined, EN_MAX);
  }
  return joined;
}

/**
 * Dispatcher: extract a topic using the language-appropriate extractor,
 * falling back to the other language when the primary one yields
 * nothing (e.g. a Chinese prompt with an English-only technical term).
 */
function extractTopic(text: string, lang: TitleLanguage): string | null {
  if (lang === 'zh') return extractChineseTopic(text) ?? extractEnglishTopic(text);
  if (lang === 'en') return extractEnglishTopic(text) ?? extractChineseTopic(text);
  return extractChineseTopic(text) ?? extractEnglishTopic(text);
}


/**
 * Multi-request-aware Chinese topic extraction.
 * Splits on CJK punctuation, scores each segment, and keeps the top-N
 * segments whose score is at least MULTI_TOPIC_SCORE_RATIO × the best
 * score. Segments are joined with " + " in original order so a single
 * user utterance with several distinct requests no longer silently drops
 * all but one of them.
 */
function extractChineseTopic(text: string): string | null {
  const segments = text
    .split(/[，。！？；：、\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .map((s) =>
      s.replace(/^(我想|我需要|我要|我想问|我想知道|请问|想一下|想问下|帮忙|帮我看|帮我)\s*/i, ''),
    )
    .filter((s) => s.length >= 3);

  if (segments.length === 0) return null;

  const scored = segments.map((seg, idx) => {
    if (seg.length === 0) return { seg, score: -9999, idx };
    const chars = [...seg];
    const contentChars = chars.filter((c) => !CN_STOP_WORDS.has(c));
    const ratio = contentChars.length / Math.max(chars.length, 1);
    const startsWithContent = contentChars.length > 0 && chars[0] === contentChars[0];
    return { seg, score: ratio * seg.length + (startsWithContent ? 2 : 0), idx };
  });

  const positive = scored.filter((s) => s.score > 0);
  if (positive.length === 0) return null;

  positive.sort((a, b) => b.score - a.score);
  const best = positive[0]!;
  const kept = positive
    .filter((s) => s.score >= best.score * MULTI_TOPIC_SCORE_RATIO)
    .slice(0, MULTI_TOPIC_MAX_SEGMENTS)
    .sort((a, b) => a.idx - b.idx);

  const joined = kept.map((k) => k.seg).join(' + ');
  if (charLength(joined) > MULTI_TOPIC_MAX_CHARS) {
    return truncateByChars(joined, MULTI_TOPIC_MAX_CHARS).replace(/\s*\+\s*$/, '');
  }
  return joined;
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

  // A standalone greeting ("hey", "你好", "hi") carries no topic signal.
  // Returning null lets the caller keep the default title instead of
  // persisting the greeting itself into the database.
  if (!isMeaningfulFirstMessage(firstUser)) {
    return null;
  }

  // Remove common prefixes
  text = text
    .replace(/^(请|帮忙|帮我|能不能|能否|可以|请帮我|能否帮我|我想|我需要|我要|我想问|我想知道|请问|想问一下|想问下)\s*/i, '')
    .replace(EN_DISCOURSE_PREFIX, '');

  // Pick extractor based on detected language. The dispatcher keeps
  // multiple distinct requests in the title instead of silently
  // dropping all but the highest-scoring one.
  const lang = detectLanguage(text);
  const topic = extractTopic(text, lang);
  if (topic) {
    const cleaned = sanitizeTitle(topic);
    const len = charLength(cleaned);
    // English extractor caps at 60 chars; Chinese caps at 30. Accept
    // either so long as the result is not noise.
    if (len >= 4 && len <= 60 && !looksLikeTitleArtifact(cleaned)) {
      return cleaned;
    }
  }

  // Fallback: CJK-safe truncation to a reasonable length.
  if (charLength(text) > TITLE_MAX_LENGTH) {
    let cut = truncateByChars(text, TITLE_MAX_LENGTH);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > TITLE_MIN_LENGTH) {
      cut = cut.slice(0, lastSpace);
    }
    return cut.trim() || null;
  }
  // Short fallback: require at least 4 chars. Anything shorter (or pure
  // noise) returns null so the caller keeps the default title.
  if (charLength(text) < 4) return null;
  return text.trim() || null;
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
  llmClient?: AIClient,
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
          { role: 'user', content: input, timestamp: Date.now() },
        ],
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          maxTokens: 120,
          temperature: 0.1,
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
          console.log(`[TitleGenerator] Stream event ${eventCount}: type=thinking, thinkingContent total len=${thinkingContent.length}, current delta len=${typeof event.data === 'string' ? event.data.length : 0}`);
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

      // Try to parse JSON from text only (never from thinking content directly)
      // Thinking content is only used as a last resort in Strategy 4 below
      let cleanedTitle: string | null = null;
      if (title.trim()) {
        try {
          // Strategy 1: field-level extraction from text channel only
          const fieldMatch = title.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          console.log(`[TitleGenerator] Field match attempt: source=text, matched=${!!fieldMatch}`);
          if (fieldMatch) {
            const extracted = fieldMatch[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            cleanedTitle = validateTitle(extracted);
            console.log(`[TitleGenerator] Field extracted from text, title="${cleanedTitle}"`);
          }
          // Strategy 2: fallback to full JSON parse from text channel only
          if (!cleanedTitle) {
            const jsonMatch = title.match(/\{[^}]*\}/s);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]!);
              if (parsed.title && typeof parsed.title === 'string') {
                cleanedTitle = validateTitle(parsed.title);
                console.log(`[TitleGenerator] JSON parsed from text, title="${cleanedTitle}"`);
              } else {
                console.log(`[TitleGenerator] JSON matched but no valid title field: keys=${Object.keys(parsed)}`);
              }
            }
          }
        } catch (e) {
          console.log(`[TitleGenerator] JSON parse failed for text: ${e instanceof Error ? e.message : String(e)}, content_len=${title.length}`);
        }
      }

      if (!cleanedTitle) {
        console.log('[TitleGenerator] JSON parse failed, trying raw text extraction');

        // Strategy 3: If LLM returned plain text (not JSON), use it directly as title.
        // This handles reasoning models that output natural language instead of JSON.
        // BUT: reasoning models also emit chain-of-thought into the text channel,
        // so we must reject anything that looks like a reasoning artifact or
        // instruction paraphrase (see looksLikeTitleArtifact).
        const rawText = title.trim();
        if (rawText) {
          // Strip common preamble patterns from raw text
          let candidate = rawText;
          // Remove leading "Title:" or "标题:" prefixes
          candidate = candidate.replace(/^(?:title|标题)\s*[:：]\s*/i, '');
          // Remove surrounding quotes
          candidate = candidate.replace(/^["「『（(]+|["」』）)]+$/g, '');
          // Take first line only (avoid multi-paragraph reasoning)
          candidate = candidate.split(/[\n\r]/)[0]!.trim();
          if (candidate.length >= 4 && candidate.length <= 60) {
            if (looksLikeTitleArtifact(candidate)) {
              console.log(`[TitleGenerator] Raw text rejected as reasoning artifact: "${candidate}"`);
            } else {
              cleanedTitle = validateTitle(candidate);
              console.log(`[TitleGenerator] Raw text extracted as title: "${cleanedTitle}"`);
            }
          }
        }

        // Strategy 4: Only if text is completely empty and thinking has content
        // This is a last resort - thinking content is NOT used if text channel has any content
        if (!cleanedTitle && !title.trim() && thinkingContent.trim()) {
          const lines = thinkingContent.trim().split(/[\n\r]/);
          // Find the last non-empty, non-reasoning line
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]!.trim();
            // Skip reasoning markers and very short lines
            if (!line || line.length < 4) continue;
            // Skip lines that look like reasoning (use enhanced patterns from looksLikeTitleArtifact)
            if (/^(?:让我|我需要|我应该|这个|这是|用户|根据|结合|首先|其次|然后|最后|我觉得|我认为|可能是|也许是|应该是)/.test(line)) continue;
            if (/^(?:i\s+(?:should|need|will|am)|let me|the user|user wants|finally|so|this is|based on|according to)\b/i.test(line)) continue;
            // Skip lines with reasoning punctuation
            if (line.endsWith('，') || line.endsWith('。') || line.endsWith('的')) continue;
            // Skip lines with uncertainty markers
            if (/^(?:可能是|也许是|应该是|可能|也许|估计|大概)/.test(line)) continue;
            if (line.length >= 4 && line.length <= 60 && !looksLikeTitleArtifact(line)) {
              cleanedTitle = validateTitle(line);
              if (cleanedTitle) {
                console.log(`[TitleGenerator] Extracted from thinking line ${i}: "${cleanedTitle}"`);
                break;
              }
            }
          }
        }

        if (!cleanedTitle) {
          console.log('[TitleGenerator] All extraction strategies failed, using heuristic fallback');
          return { title: fallback };
        }
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
