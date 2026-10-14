/**
 * Handlebars template types — Plan 550.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { HelperDelegate, HelperOptions } from 'handlebars';

/**
 * Frontmatter keys recognised by `parseFrontmatter`. The body is the
 * Handlebars template; the frontmatter carries cache-control and routing
 * metadata so the renderer can preserve prompt-cache stability without
 * the old TS layer's volatile-section list.
 *
 * - `cache`:    'static' (cacheable) | 'volatile' (recomputed every turn;
 *               matches the old `volatilePromptSection` semantics)
 * - `id`:       unique identifier for the compiled template cache
 * - `partials`: names declared in frontmatter that this template may pull
 *               in via `{{> partial_name }}`; pre-loads them at compile time
 */
export interface HbsFrontmatter {
  cache?: 'static' | 'volatile';
  id?: string;
  partials?: string[];
  [key: string]: unknown;
}

/**
 * Loaded Handlebars asset, returned by `loadHbsAsset`.
 */
export interface HbsAsset {
  /** Absolute path the asset was loaded from. */
  path: string;
  /** Parsed frontmatter (defaults to `{}` when absent). */
  frontmatter: HbsFrontmatter;
  /** The Handlebars template body (frontmatter stripped). */
  body: string;
}

/**
 * Compile cache entry.
 */
export interface HbsCompiledTemplate {
  templateId: string;
  /** Source body the template was compiled from. */
  source: string;
  /** Frontmatter for the asset. */
  frontmatter: HbsFrontmatter;
  /** Compiled Handlebars delegate. */
  compiled: HandlebarsTemplateDelegate;
}

/**
 * `HandlebarsTemplateDelegate` from the upstream package; aliased so the
 * rest of the codebase does not import `handlebars` directly.
 */
export type HandlebarsTemplateDelegate = (
  context: Record<string, unknown>,
  options?: { allowProtoMethodsByDefault?: boolean; allowProtoPropertiesByDefault?: boolean },
) => string;

/**
 * Helper function signature (matches Handlebars's `HelperDelegate`).
 */
export type HbsHelper = HelperDelegate;

/** Re-export so consumers do not need to add `handlebars` as a direct dep. */
export type { HelperDelegate, HelperOptions };