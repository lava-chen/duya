/**
 * Handlebars renderer — Plan 550.
 *
 * Loads, compiles, and renders `.hbs` prompt templates. The renderer is the
 * single point that owns the compile cache; assets are loaded via
 * `./assetLoader` so test fixtures can stub the source transparently.
 *
 * Design choices, mirrored from minimax-code's
 * `packages/local-runtime-v2/src/service/agent/builtin/prompt-renderer.ts`:
 *
 * 1. `Handlebars.create()` per renderer (not the global default instance) so
 *    strict mode + custom helpers stay local.
 * 2. `noEscape: true` — prompt content is markdown we want verbatim; we are
 *    not producing HTML.
 * 3. `strict: true` so undefined context keys throw — explicit over implicit,
 *    same as mcode.
 * 4. Cache keyed by template id (`<assetsRoot>/<relativePath>`) so reloads
 *    are O(1). The cache is invalidated when `invalidate()` is called (e.g.
 *    when a skill is hot-reloaded).
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import Handlebars from 'handlebars';

import { loadHbsAssetSync } from './assetLoader.js';
import type {
  HbsCompiledTemplate,
  HbsFrontmatter,
  HbsHelper,
  HandlebarsTemplateDelegate,
} from './types.js';

export interface HbsPromptRendererOptions {
  /** Absolute path to the directory that holds `.hbs` assets. */
  assetsRoot: string;
  /**
   * Custom helpers keyed by name. Registered at renderer construction so
   * every compiled template sees them. mcode uses helpers like `eq` /
   * `and`; we register a minimal set by default.
   */
  helpers?: Record<string, HbsHelper>;
  /**
   * Custom partials keyed by name. Loaded into the Handlebars instance at
   * construction so `{{> name }}` references resolve at compile time.
   */
  partials?: Record<string, string>;
}

/**
 * Default helpers every prompt renderer registers. Subset of mcode's
 * helper list — kept narrow because the static sections we will migrate
 * only need truthiness checks.
 *
 * Note: when a helper is used as a subexpression (`{{#if (and a b)}}`),
 * Handlebars calls it with positional args and expects a return value used
 * as a truthiness check. Returning a rendered HTML fragment from a
 * subexpression helper does not work — the inner `{{#if}}` still treats
 * the result as a boolean. Keep these helpers pure (return boolean).
 */
function defaultHelpers(): Record<string, HbsHelper> {
  return {
    /**
     * `{{#if (and a b)}}` — both values truthy. Handlebars' built-in `if`
     * only takes a single argument, so we expose `and` for two-arg checks.
     */
    and(a: unknown, b: unknown): boolean {
      return Boolean(a) && Boolean(b);
    },
    /**
     * `{{#if (or a b)}}` — at least one truthy.
     */
    or(a: unknown, b: unknown): boolean {
      return Boolean(a) || Boolean(b);
    },
    /**
     * `{{#if (eq a b)}}` — strict equality.
     */
    eq(a: unknown, b: unknown): boolean {
      return a === b;
    },
    /**
     * `{{#if (neq a b)}}` — strict inequality.
     */
    neq(a: unknown, b: unknown): boolean {
      return a !== b;
    },
  };
}

/**
 * Compile cache entry — keeps the original source so callers can inspect
 * the cache key, the body, and the frontmatter for diagnostics.
 */
interface CacheEntry extends HbsCompiledTemplate {}

export class HbsPromptRenderer {
  private readonly handlebars: typeof Handlebars;
  private readonly assetsRoot: string;
  private readonly cache: Map<string, CacheEntry> = new Map();
  /** Counter for cache hit / miss reporting. */
  private hits = 0;
  private misses = 0;

  constructor(options: HbsPromptRendererOptions) {
    this.assetsRoot = options.assetsRoot;
    this.handlebars = Handlebars.create();
    this.handlebars.compile = this.handlebars.compile.bind(this.handlebars);
    // Prompt content is markdown; never HTML-escape. Same flag as mcode.
    const allHelpers: Record<string, HbsHelper> = {
      ...defaultHelpers(),
      ...(options.helpers ?? {}),
    };
    for (const [name, helper] of Object.entries(allHelpers)) {
      this.handlebars.registerHelper(name, helper);
    }
    if (options.partials) {
      for (const [name, body] of Object.entries(options.partials)) {
        this.handlebars.registerPartial(name, body);
      }
    }
  }

  /** Render a `.hbs` template by relative path. Compiles on first use. */
  render(relativePath: string, context: Record<string, unknown> = {}): string {
    const entry = this.compile(relativePath);
    return entry.compiled(context);
  }

  /**
   * Compile (or return cached) `.hbs` template by relative path. Exposed
   * for callers that want to inspect the compiled form (e.g. partial
   * registration, lint tooling).
   */
  compile(relativePath: string): CacheEntry {
    const cached = this.cache.get(relativePath);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const asset = loadHbsAssetSync(this.assetsRoot, relativePath);
    const compiled = this.handlebars.compile(asset.body, {
      noEscape: true,
      strict: true,
    });
    const entry: CacheEntry = {
      templateId: relativePath,
      source: asset.body,
      frontmatter: asset.frontmatter,
      compiled: compiled as unknown as HandlebarsTemplateDelegate,
    };
    this.cache.set(relativePath, entry);
    return entry;
  }

  /** Drop every compiled template. Use after hot-reloading a `.hbs` file. */
  invalidate(): void {
    this.cache.clear();
  }

  /** Drop one template (no-op if missing). */
  invalidateOne(relativePath: string): void {
    this.cache.delete(relativePath);
  }

  /** Diagnostics — number of cache hits since construction. */
  cacheHits(): number {
    return this.hits;
  }

  /** Diagnostics — number of cache misses since construction. */
  cacheMisses(): number {
    return this.misses;
  }

  /** Diagnostics — current cache size. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Resolve the assets root the renderer was bound to. */
  getAssetsRoot(): string {
    return this.assetsRoot;
  }

  /**
   * Return the frontmatter of a compiled template, or `undefined` if the
   * template has not been compiled yet. Used by the prompt cache layer to
   * decide whether a template is `static` (cacheable) or `volatile`.
   */
  frontmatterFor(relativePath: string): HbsFrontmatter | undefined {
    return this.cache.get(relativePath)?.frontmatter;
  }
}