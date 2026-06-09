/**
 * context-usage-utils.ts
 *
 * Token estimation + category bucketing for the context usage ring.
 *
 * The backend only ships aggregate `tokenUsage` on the last assistant message,
 * not per-message tokens. To produce a per-category grid (and a breakdown
 * panel) we estimate each message's tokens locally using the same shape
 * claude-code's `analyzeContext.ts` uses:
 *
 *   1. Base text: characters / 4 (rough BPE proxy; tool & attachment content
 *      also goes through this since it ends up serialized as text in the
 *      request body).
 *   2. Each tool_use / tool_result block also pays a fixed ~6 token schema
 *      overhead to account for `{"name": "...", "input": {...}}` wrapping
 *      that doesn't show up in raw character count.
 *   3. Thinking blocks: char/4, no extra overhead.
 *   4. Attachments: char/4 of `text` if extracted, else a 700 token floor
 *      per image (Anthropic's image budget is 1.6K tokens, but extracted
 *      chunks usually yield a lower effective count).
 *
 * Category estimates are then normalized against the aggregate `used` from
 * `tokenUsage` so the sum of category tokens == used (the grid can't lie
 * about the total).
 */
import type { ContentBlock, Message } from '@/types/message';

export type ContextCategory =
  | 'user_text'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'attachment'
  | 'compact_summary'
  | 'subagent'
  | 'system';

export interface ContextSource {
  /** Stable id: messageId:contentIndex */
  id: string;
  category: ContextCategory;
  /** Short label used in tooltips & breakdown rows */
  label: string;
  /** Estimated tokens for this source (after normalization) */
  tokens: number;
  messageId: string;
  /** First 120 chars, used in expandable detail rows */
  preview?: string;
  toolName?: string;
  subAgentId?: string;
  attachmentName?: string;
}

export interface ContextBreakdown {
  sources: ContextSource[];
  byCategory: Map<ContextCategory, ContextSource[]>;
  /** Total of all sources after normalization — equals `used` when possible */
  total: number;
  /** Grid columns × rows (e.g. 10×10 = 100 cells for 200K context) */
  columns: number;
  rows: number;
  /** One cell per non-deferred category, with `squareFullness` for the
   *  glyph choice. Walked row-major when rendering. */
  gridSquares: GridSquare[];
  /** Each category's allocated square count, in CATEGORY_ORDER. Used by
   *  the breakdown modal to label rows. */
  categorySquareCounts: Map<ContextCategory, number>;
  contextWindow: number;
  rawMaxTokens: number;
  state: 'normal' | 'warning' | 'critical';
}

export interface GridSquare {
  category: ContextCategory;
  /** 0..1, used to choose solid vs hollow glyph */
  fullness: number;
  /** True if this square represents the autocompact buffer (claude-code
   *  shows it as a reserved row at the end of the used area) */
  isReserved?: boolean;
}

const TOOL_SCHEMA_OVERHEAD_TOKENS = 6;
const ATTACHMENT_IMAGE_FLOOR_TOKENS = 700;
/** Grid dimensions follow claude-code: 10×10 for 200K context windows,
 *  20×10 for 1M+. Total cells represent the *whole* context window — the
 *  free portion is shown too, so users can see how much room is left. */
export const GRID_COLUMNS = 10;
export const GRID_ROWS_DEFAULT = 10;
export const GRID_ROWS_LARGE = 10;
export const GRID_COLUMNS_LARGE = 20;
export const GRID_COLUMNS_NARROW = 5;
export const GRID_ROWS_NARROW = 5;
const LARGE_CONTEXT_THRESHOLD = 1_000_000;

const CATEGORY_ORDER: ContextCategory[] = [
  'system',
  'compact_summary',
  'attachment',
  'tool_call',
  'tool_result',
  'thinking',
  'user_text',
  'assistant_text',
  'subagent',
];

const CATEGORY_LABELS: Record<ContextCategory, string> = {
  user_text: 'User',
  assistant_text: 'Assistant',
  tool_call: 'Tool calls',
  tool_result: 'Tool results',
  thinking: 'Thinking',
  attachment: 'Attachments',
  compact_summary: 'Compact summary',
  subagent: 'Subagent',
  system: 'System',
};

/** Rough character → token conversion. 4 chars ≈ 1 token for English /
 *  code, which is what we mostly deal with. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

function blockToText(block: ContentBlock): string {
  if (typeof block === 'string') return block;
  if (typeof block?.text === 'string') return block.text;
  if (typeof block?.content === 'string') return block.content;
  if (typeof block?.input !== 'undefined') {
    try {
      return JSON.stringify(block.input);
    } catch {
      return '';
    }
  }
  return '';
}

interface RawSource {
  category: ContextCategory;
  label: string;
  tokens: number;
  messageId: string;
  preview?: string;
  toolName?: string;
  subAgentId?: string;
  attachmentName?: string;
}

/** Build a per-message source list using local estimation. The sum of
 *  returned token counts is *unnormalized* — call `normalizeAndBuildGrid`
 *  to scale to the aggregate `used` from tokenUsage. */
export function extractSources(messages: Message[]): RawSource[] {
  const out: RawSource[] = [];

  for (const msg of messages) {
    if (msg.isCompactBoundary) continue;
    if (msg.isCompactSummary) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(blockToText).join('');
      out.push({
        category: 'compact_summary',
        label: `Compact summary${msg.compactedMessageCount ? ` (${msg.compactedMessageCount} msgs)` : ''}`,
        tokens: estimateTokens(text),
        messageId: msg.id,
        preview: text.slice(0, 120),
      });
      continue;
    }

    if (msg.subAgentId) {
      // Subagent spans are charged to the parent assistant message; track a
      // separate bucket so users can see how much went to delegation.
      out.push({
        category: 'subagent',
        label: `Subagent ${msg.subAgentId.slice(0, 8)}`,
        tokens: 0, // counted as part of assistant_text below
        messageId: msg.id,
        subAgentId: msg.subAgentId,
      });
    }

    // Thinking block (assistant only, but harmless for any role)
    if (msg.thinking) {
      out.push({
        category: 'thinking',
        label: 'Thinking',
        tokens: estimateTokens(msg.thinking),
        messageId: msg.id,
        preview: msg.thinking.slice(0, 120),
      });
    }

    // Attachments — images are estimated by a floor since we don't know the
    // exact resolution the API charges for. Extracted text uses char/4.
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const text = att.text ?? '';
        const isImage = (att.type ?? '').startsWith('image/');
        const tokens = isImage
          ? Math.max(ATTACHMENT_IMAGE_FLOOR_TOKENS, estimateTokens(text))
          : estimateTokens(text);
        out.push({
          category: 'attachment',
          label: att.name || 'Attachment',
          tokens,
          messageId: msg.id,
          attachmentName: att.name,
          preview: att.name,
        });
      }
    }

    // Main content — walk ContentBlock[] or treat as a single string.
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.length === 0) continue;
      out.push({
        category: bucketForRole(msg),
        label: labelForRole(msg),
        tokens: estimateTokens(content),
        messageId: msg.id,
        preview: content.slice(0, 120),
      });
      continue;
    }

    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        const text = blockToText(block);
        if (!text && !block?.type) continue;
        const type = block?.type as string | undefined;
        if (type === 'tool_use') {
          const toolName = (block as { name?: string }).name ?? 'tool';
          out.push({
            category: 'tool_call',
            label: toolName,
            tokens: estimateTokens(text) + TOOL_SCHEMA_OVERHEAD_TOKENS,
            messageId: msg.id,
            toolName,
            preview: text.slice(0, 120) || toolName,
          });
        } else if (type === 'tool_result') {
          out.push({
            category: 'tool_result',
            label: 'Tool result',
            tokens: estimateTokens(text) + TOOL_SCHEMA_OVERHEAD_TOKENS,
            messageId: msg.id,
            preview: text.slice(0, 120),
          });
        } else if (type === 'thinking') {
          out.push({
            category: 'thinking',
            label: 'Thinking',
            tokens: estimateTokens(text),
            messageId: msg.id,
            preview: text.slice(0, 120),
          });
        } else if (type === 'text') {
          out.push({
            category: bucketForRole(msg),
            label: labelForRole(msg),
            tokens: estimateTokens(text),
            messageId: msg.id,
            preview: text.slice(0, 120),
          });
        } else {
          // Unknown block type — bucket as system and keep cost minimal.
          out.push({
            category: 'system',
            label: type ?? 'System',
            tokens: estimateTokens(text) + TOOL_SCHEMA_OVERHEAD_TOKENS,
            messageId: msg.id,
            preview: text.slice(0, 120),
          });
        }
      }
    }
  }

  return out;
}

function bucketForRole(msg: Message): ContextCategory {
  if (msg.role === 'user') return 'user_text';
  if (msg.role === 'assistant') return 'assistant_text';
  if (msg.role === 'tool') return 'tool_result';
  return 'system';
}

function labelForRole(msg: Message): string {
  if (msg.role === 'user') return 'User';
  if (msg.role === 'assistant') return 'Assistant';
  if (msg.role === 'tool') return 'Tool result';
  return 'System';
}

/** Normalize raw estimates so their sum equals `targetTotal`, then
 *  distribute TOTAL_SQUARES cells across categories proportional to their
 *  share of the *context window* (not the used portion). The free portion
 *  gets a 'free' bucket so the grid represents the full window shape. */
export function normalizeAndBuildGrid(
  raw: RawSource[],
  targetTotal: number,
  contextWindow: number,
  state: ContextBreakdown['state'],
  narrow = false,
): ContextBreakdown {
  const { columns, rows, total: TOTAL_SQUARES } = gridDimensions(
    contextWindow,
    narrow,
  );

  const sum = raw.reduce((acc, s) => acc + s.tokens, 0);
  const scale = sum > 0 && targetTotal > 0 ? targetTotal / sum : 0;

  const sources: ContextSource[] = raw
    .filter((s) => s.tokens > 0)
    .map((s, i) => ({
      id: `${s.messageId}:${i}`,
      category: s.category,
      label: s.label,
      tokens: Math.max(1, Math.round(s.tokens * scale)),
      messageId: s.messageId,
      preview: s.preview,
      toolName: s.toolName,
      subAgentId: s.subAgentId,
      attachmentName: s.attachmentName,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const byCategory = new Map<ContextCategory, ContextSource[]>();
  for (const s of sources) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  // Sum tokens per category, then allocate squares proportional to
  // share-of-context-window (not share-of-used). Free space = whatever
  // is left.
  const categoryTokens = new Map<ContextCategory, number>();
  for (const s of sources) {
    categoryTokens.set(
      s.category,
      (categoryTokens.get(s.category) ?? 0) + s.tokens,
    );
  }

  const categorySquareCounts = new Map<ContextCategory, number>();
  let allocated = 0;
  const orderedNonFree: { cat: ContextCategory; tokens: number }[] = [];
  for (const cat of CATEGORY_ORDER) {
    const tokens = categoryTokens.get(cat) ?? 0;
    if (tokens <= 0) continue;
    orderedNonFree.push({ cat, tokens });
  }
  // Sort by tokens desc for visual prominence
  orderedNonFree.sort((a, b) => b.tokens - a.tokens);

  for (const { cat, tokens } of orderedNonFree) {
    const squares = Math.max(
      1,
      Math.round((tokens / Math.max(1, contextWindow)) * TOTAL_SQUARES),
    );
    categorySquareCounts.set(cat, squares);
    allocated += squares;
  }
  // Clamp allocated back to TOTAL_SQUARES — rounding can overshoot.
  if (allocated > TOTAL_SQUARES) {
    // Trim the largest category until it fits.
    let overflow = allocated - TOTAL_SQUARES;
    for (const { cat } of orderedNonFree) {
      if (overflow <= 0) break;
      const cur = categorySquareCounts.get(cat) ?? 0;
      if (cur <= 1) continue;
      const trim = Math.min(overflow, cur - 1);
      categorySquareCounts.set(cat, cur - trim);
      overflow -= trim;
    }
  }
  const freeSquares = Math.max(0, TOTAL_SQUARES - allocated);

  // Build the cell list in CATEGORY_ORDER (stable). Each cell carries its
  // own fullness; the partial cell at the end of a category's run encodes
  // the remainder.
  const gridSquares: GridSquare[] = [];
  for (const cat of CATEGORY_ORDER) {
    const squares = categorySquareCounts.get(cat) ?? 0;
    const tokens = categoryTokens.get(cat) ?? 0;
    if (squares === 0) continue;
    const tokensPerSquare = tokens / squares;
    for (let i = 0; i < squares; i++) {
      const isLast = i === squares - 1;
      gridSquares.push({
        category: cat,
        // Full cell if tokensPerSquare >= 1 cell's worth (1 / TOTAL_SQUARES
        // of the context window). The very last cell of a category's run
        // may be fractional.
        fullness: isLast
          ? Math.min(1, tokensPerSquare * squares - Math.floor(tokensPerSquare * squares - 1))
          : 1,
      });
    }
  }
  // Fill remaining with free-space cells. Free space is always "full" so
  // the free glyph (⛶) is what users see; renderer decides.
  for (let i = 0; i < freeSquares; i++) {
    gridSquares.push({ category: '__free__' as unknown as ContextCategory, fullness: 1 });
  }
  // Pad to exactly TOTAL_SQUARES in case the trim above underflowed.
  while (gridSquares.length < TOTAL_SQUARES) {
    gridSquares.push({
      category: '__free__' as unknown as ContextCategory,
      fullness: 1,
    });
  }

  return {
    sources,
    byCategory,
    total: targetTotal,
    columns,
    rows,
    gridSquares,
    categorySquareCounts,
    contextWindow,
    rawMaxTokens: contextWindow,
    state,
  };
}

export function getCategoryLabel(category: ContextCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

export const GRID_CONSTANTS = {
  GRID_COLUMNS,
  GRID_ROWS_DEFAULT,
  GRID_ROWS_LARGE,
  GRID_COLUMNS_LARGE,
  GRID_COLUMNS_NARROW,
  GRID_ROWS_NARROW,
  LARGE_CONTEXT_THRESHOLD,
} as const;

/** Total cells for a given context window — mirrors claude-code's choice
 *  of 10×10 for sub-1M and 20×10 for 1M+. Narrow screens collapse to 5×5
 *  but we don't have terminal-width here; the modal/popover can call this
 *  with the actual width to opt into the narrow variant. */
export function gridDimensions(
  contextWindow: number,
  narrow = false,
): { columns: number; rows: number; total: number } {
  const large = contextWindow >= LARGE_CONTEXT_THRESHOLD;
  if (narrow) {
    const columns = large ? GRID_COLUMNS_NARROW : GRID_COLUMNS_NARROW;
    const rows = large ? GRID_ROWS_NARROW : GRID_ROWS_NARROW;
    return { columns, rows, total: columns * rows };
  }
  const columns = large ? GRID_COLUMNS_LARGE : GRID_COLUMNS;
  const rows = large ? GRID_ROWS_LARGE : GRID_ROWS_DEFAULT;
  return { columns, rows, total: columns * rows };
}
