/**
 * Handlebars asset loader — Plan 550.
 *
 * Loads `.hbs` files from a configurable assets root and parses an optional
 * YAML frontmatter block (the same convention mcode uses in
 * `local-runtime-v2/assets/agents/mavis/system-prompt.md.hbs`). Mirrors the
 * minimal subset of mcode's `parseFrontmatter` in
 * `packages/local-runtime-v2/src/service/agent/builtin/prompt-renderer.ts`
 * but only enough to drive the duya renderer.
 *
 * The loader is intentionally stateless and side-effect free; the renderer
 * owns caching. Tests in `tests/unit/prompts/hbs-renderer.test.ts` exercise
 * it directly with fixture strings.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { HbsAsset, HbsFrontmatter } from './types.js';

const FRONTMATTER_RE = new RegExp('^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?', 'u');

/**
 * Parse a YAML frontmatter block from a `.hbs` file. Returns an empty
 * frontmatter record when the marker is absent.
 *
 * Behaviour matches mcode's `parseFrontmatter`:
 * - Frontmatter must start on line 1 with `---`.
 * - Body is everything after the closing `---` marker.
 * - Empty / malformed frontmatter parses to `{}` (not an error) so a
 *   missing marker does not break the renderer.
 */
export function parseFrontmatter(raw: string): {
  readonly frontmatter: HbsFrontmatter;
  readonly body: string;
} {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const bodyAfterFrontmatter = raw.slice(match[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? '');
  } catch {
    // Malformed YAML → treat as no frontmatter but still strip the
    // opening `--- ... ---` block so the body is usable as a template.
    return { frontmatter: {}, body: bodyAfterFrontmatter };
  }
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as HbsFrontmatter)
      : {};
  return { frontmatter, body: bodyAfterFrontmatter };
}

/**
 * Load a single `.hbs` asset by relative path under `assetsRoot`.
 *
 * @param assetsRoot  Absolute directory that holds the `.hbs` files.
 * @param relativePath  Path relative to `assetsRoot` (POSIX or native).
 *
 * @throws when the file is missing, unreadable, or escapes `assetsRoot`.
 */
export async function loadHbsAsset(
  assetsRoot: string,
  relativePath: string,
): Promise<HbsAsset> {
  const absolute = resolve(assetsRoot, relativePath);
  // Defence against path traversal: the resolved path must stay under
  // `assetsRoot`. The renderer treats the asset as a module anyway, but
  // refusing traversal here keeps tests deterministic.
  const rootWithSep = assetsRoot.endsWith('/') || assetsRoot.endsWith('\\')
    ? assetsRoot
    : assetsRoot + '/';
  if (!absolute.startsWith(rootWithSep) && !absolute.startsWith(assetsRoot)) {
    throw new Error(
      `HbsAssetLoader: '${relativePath}' resolves outside assetsRoot '${assetsRoot}'`,
    );
  }
  const raw = await readFile(absolute, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { path: absolute, frontmatter, body };
}

/**
 * Synchronous variant — used by the renderer when `compile()` is called
 * from a sync hot path (e.g. buildSystemPrompt during a stream).
 *
 * @throws when the file is missing or unreadable.
 */
export function loadHbsAssetSync(
  assetsRoot: string,
  relativePath: string,
): HbsAsset {
  // Lazy `require` to keep the ESM module surface clean — the renderer is
  // the only call site and we want the async loader for production use.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const absolute = resolve(assetsRoot, relativePath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { path: absolute, frontmatter, body };
}