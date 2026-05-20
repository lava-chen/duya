/**
 * Shared utilities for platform adapters
 *
 * Ported and enhanced from hermes-agent/gateway/platforms/helpers.py
 */

import type { PlatformType } from '../types.js';

// =============================================================================
// Message Splitting
// =============================================================================

/**
 * Split a message into chunks that fit within maxLength.
 * Prioritizes splitting at newlines, then spaces, then hard cutoff.
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// =============================================================================
// Markdown Stripping
// =============================================================================

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const STRIKETHROUGH_RE = /~~([^~]+)~~/g;
const HEADER_RE = /^#{1,6}\s+/gm;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const BLOCKQUOTE_RE = /^>\s*/gm;
const LIST_RE = /^[\s]*[-*+]\s+/gm;
const MULTI_NEWLINE_RE = /\n{3,}/g;

/**
 * Strip all markdown formatting, returning plain text.
 * Used for platforms that don't support markdown (SMS, etc.).
 */
export function stripMarkdown(content: string): string {
  if (!content) return '';

  let result = content;

  // Remove code blocks first (they may contain other markdown chars)
  result = result.replace(CODE_BLOCK_RE, '\n');
  result = result.replace(INLINE_CODE_RE, '$1');

  // Remove formatting
  result = result.replace(BOLD_RE, '$1');
  result = result.replace(ITALIC_RE, '$1');
  result = result.replace(STRIKETHROUGH_RE, '$1');

  // Remove structural elements
  result = result.replace(HEADER_RE, '');
  result = result.replace(LINK_RE, '$1');
  result = result.replace(IMAGE_RE, '$1');
  result = result.replace(BLOCKQUOTE_RE, '');
  result = result.replace(LIST_RE, '');

  // Normalize whitespace
  result = result.replace(MULTI_NEWLINE_RE, '\n\n');
  result = result.trim();

  return result;
}

// =============================================================================
// WeChat-specific Markdown Rewriting
// =============================================================================

/**
 * Rewrite markdown headers for WeChat compatibility.
 * - # Title -> 【Title】
 * - ## Sub -> **Sub**
 */
export function rewriteHeadersForWeixin(content: string): string {
  if (!content) return '';

  const lines = content.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // H1: # Title -> 【Title】
    if (line.startsWith('# ')) {
      result.push('【' + line.slice(2).trim() + '】');
      continue;
    }

    // H2-H6: ## Sub -> **Sub**
    const hMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (hMatch) {
      result.push('**' + hMatch[2].trim() + '**');
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Parse a markdown table row into an array of cells.
 */
function splitTableRow(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map(cell => cell.trim());
}

/**
 * Rewrite markdown tables for WeChat compatibility.
 * Converts GFM tables to "- Key: Value" list format.
 */
export function rewriteTableBlockForWeixin(content: string): string {
  if (!content) return '';

  const lines = content.split('\n');
  const result: string[] = [];
  let inTable = false;
  let headerRow: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Table separator row
    if (/^\|[\s:-]+\|$/.test(trimmed)) {
      inTable = true;
      continue;
    }

    // Table row
    if (inTable && /^\|.*\|$/.test(trimmed)) {
      const cells = splitTableRow(trimmed);

      // If this is the header row, save it for subsequent data rows
      if (headerRow.length === 0 && cells.length > 0) {
        headerRow = cells;
        continue;
      }

      // Data row
      if (headerRow.length > 0) {
        for (let i = 0; i < cells.length && i < headerRow.length; i++) {
          result.push(`- ${headerRow[i]}: ${cells[i]}`);
        }
      } else {
        result.push(...cells.map(cell => `- ${cell}`));
      }
      continue;
    }

    // Not a table row
    if (inTable) {
      inTable = false;
      headerRow = [];
    }
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Strip WeChat markdown with aggressive reformatting.
 * Used when WeChat native rendering is insufficient.
 */
export function stripWeixinMarkdown(content: string): string {
  if (!content) return '';

  let result = content;

  // Rewrite headers first
  result = rewriteHeadersForWeixin(result);

  // Then rewrite tables
  result = rewriteTableBlockForWeixin(result);

  // Finally strip remaining markdown
  result = stripMarkdown(result);

  return result;
}

// =============================================================================
// Text Batch Aggregator
// =============================================================================

export interface BatchItem {
  text: string;
  timestamp: number;
}

/**
 * Aggregates text messages within a time window and returns the aggregated text.
 * Used to batch rapid successive messages into one.
 */
export class TextBatchAggregator {
  private items: BatchItem[] = [];
  private readonly maxItems: number;
  private readonly windowMs: number;
  private readonly maxLength: number;

  constructor(options?: {
    maxItems?: number;
    windowMs?: number;
    maxLength?: number;
  }) {
    this.maxItems = options?.maxItems ?? 10;
    this.windowMs = options?.windowMs ?? 500;
    this.maxLength = options?.maxLength ?? 4000;
  }

  add(text: string): void {
    this.items.push({
      text,
      timestamp: Date.now(),
    });

    // Prune old items
    const cutoff = Date.now() - this.windowMs;
    this.items = this.items.filter(item => item.timestamp >= cutoff);

    // Limit items
    if (this.items.length > this.maxItems) {
      this.items = this.items.slice(-this.maxItems);
    }
  }

  flush(): string {
    if (this.items.length === 0) return '';

    const combined = this.items.map(item => item.text).join('\n\n');
    this.items = [];

    if (combined.length <= this.maxLength) {
      return combined;
    }

    return combined.slice(0, this.maxLength - 3) + '...';
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}

// =============================================================================
// Platform Display Config
// =============================================================================

export interface DisplayConfig {
  tool_progress: 'on' | 'off';
  streaming: boolean;
  tool_preview_length: number;
  show_reasoning: boolean;
}

type DisplayTier = 'high' | 'medium' | 'low';

const DISPLAY_TIERS: Record<PlatformType, DisplayTier> = {
  telegram: 'high',
  discord: 'high',
  qq: 'high',
  whatsapp: 'medium',
  feishu: 'medium',
  weixin: 'low',
};

const DEFAULT_CONFIGS: Record<DisplayTier, DisplayConfig> = {
  high: {
    tool_progress: 'on',
    streaming: true,
    tool_preview_length: 200,
    show_reasoning: true,
  },
  medium: {
    tool_progress: 'on',
    streaming: false,
    tool_preview_length: 100,
    show_reasoning: false,
  },
  low: {
    tool_progress: 'off',
    streaming: false,
    tool_preview_length: 40,
    show_reasoning: false,
  },
};

/**
 * Get display configuration for a platform.
 * Resolution order: platform config > tier default
 */
export function getDisplayConfig(
  platform: PlatformType,
  overrides?: Partial<DisplayConfig>
): DisplayConfig {
  const tier = DISPLAY_TIERS[platform] ?? 'medium';
  const base = DEFAULT_CONFIGS[tier];

  return {
    ...base,
    ...overrides,
  };
}
