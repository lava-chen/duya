/**
 * Prompt Section Helpers
 * Factory functions for creating cached and volatile prompt sections
 */

import type { PromptSection } from '../types.js'

/**
 * Create a cached (static) prompt section.
 * The section is computed once and cached until explicitly cleared.
 * Use for content that doesn't change between turns.
 *
 * @param name - Unique identifier for the section
 * @param compute - Function to compute the section content
 *
 * @example
 * ```typescript
 * const introSection = cachedPromptSection('intro', () => 'You are a helpful assistant.')
 * ```
 */
export function cachedPromptSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
): PromptSection {
  return {
    name,
    compute,
    volatile: false,
  }
}

/**
 * Create a volatile (dynamic) prompt section.
 * WARNING: This section recomputes every turn and will break prompt caching.
 * Use only for truly dynamic content like environment info, MCP instructions, etc.
 *
 * @param name - Unique identifier for the section
 * @param compute - Function to compute the section content
 * @param reason - Explanation of why this section must be volatile (for debugging)
 *
 * @example
 * ```typescript
 * const envSection = volatilePromptSection('environment', async () => {
 *   return `Working directory: ${process.cwd()}`
 * }, 'Changes on every turn based on current directory')
 * ```
 */
export function volatilePromptSection(
  name: string,
  compute: () => string | null | Promise<string | null>,
  _reason?: string,
): PromptSection {
  return {
    name,
    compute,
    volatile: true,
  }
}

/**
 * Helper to create a simple string section.
 * The string is returned as-is without wrapping.
 */
export function simpleSection(name: string, content: string): PromptSection {
  return cachedPromptSection(name, () => content)
}

/**
 * Helper to prepend bullets to an array of items.
 * Used for formatting section content with bullet points.
 */
export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap(item =>
    Array.isArray(item)
      ? item.map(subitem => `  - ${subitem}`)
      : [` - ${item}`],
  )
}
