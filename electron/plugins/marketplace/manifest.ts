// manifest.ts — marketplace catalog (`marketplace.json`) reader (Plan 455).
// Codex parity (doc 17.1/17.3): five search paths including the Claude and
// Cursor plugin-market locations, first match wins; entries carry a
// discriminated `source` field and an optional installation/auth policy.
//
// Security: a marketplace manifest is REMOTE content. Every path it
// declares is resolved through a containment fence — `../` or absolute
// escapes out of the marketplace clone are rejected, never joined blind.
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

/** Search order — duya root manifest first, then codex-compatible paths. */
export const MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  'marketplace.json',
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
] as const;

export type MarketplaceInstallPolicy = 'not_available' | 'available' | 'installed_by_default';
export type MarketplaceAuthPolicy = 'on_install' | 'on_use';

const LocalPluginSourceSchema = z.object({
  source: z.literal('local'),
  path: z.string().min(1),
});

const GitPluginSourceSchema = z.object({
  source: z.literal('git'),
  url: z.string().min(1),
  /** Subdirectory inside the cloned repo that holds the plugin. */
  path: z.string().optional(),
  ref_name: z.string().optional(),
  sha: z.string().optional(),
});

const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  source: z.discriminatedUnion('source', [LocalPluginSourceSchema, GitPluginSourceSchema]),
  policy: z
    .object({
      installation: z.enum(['not_available', 'available', 'installed_by_default']).optional(),
      authentication: z.enum(['on_install', 'on_use']).optional(),
    })
    .optional(),
  category: z.string().optional(),
});

const MarketplaceManifestSchema = z.object({
  name: z.string().min(1),
  interface: z.object({ displayName: z.string().optional() }).optional(),
  plugins: z.array(MarketplacePluginEntrySchema),
});

export type MarketplacePluginSource =
  | z.infer<typeof LocalPluginSourceSchema>
  | z.infer<typeof GitPluginSourceSchema>;

export interface MarketplacePluginEntry {
  name: string;
  source: MarketplacePluginSource;
  policy?: {
    installation?: MarketplaceInstallPolicy;
    authentication?: MarketplaceAuthPolicy;
  };
  category?: string;
}

export interface LoadedMarketplaceManifest {
  /** The relative path the manifest was found at (codex parity info). */
  manifestPath: string;
  name: string;
  displayName?: string;
  plugins: MarketplacePluginEntry[];
}

/**
 * Resolve `sub` under `root` and enforce that the result stays inside the
 * root (codex 17.4.3 `canonicalize().startsWith()` defense, applied to
 * manifest-declared paths). Absolute paths and `..` escapes throw.
 */
export function resolveContainedPath(root: string, sub: string): string {
  const canonicalRoot = fs.realpathSync(root);
  const resolved = path.resolve(canonicalRoot, sub);
  if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) {
    throw new Error(`path escapes marketplace root: ${sub}`);
  }
  return resolved;
}

/**
 * Read and validate the marketplace catalog from `marketplaceDir`.
 * Returns null when no manifest file exists; throws on malformed content
 * so callers can surface a per-marketplace sync error.
 */
export function readMarketplaceManifest(marketplaceDir: string): LoadedMarketplaceManifest | null {
  let foundRelPath: string | null = null;
  let raw: string | null = null;

  // relPaths are compile-time constants; still resolved through the fence
  // so the loop is uniform and symlinked roots are canonicalized.
  for (const relPath of MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const candidate = resolveContainedPath(marketplaceDir, relPath);
    if (fs.existsSync(candidate)) {
      foundRelPath = relPath;
      raw = fs.readFileSync(candidate, 'utf8');
      break;
    }
  }
  if (!foundRelPath || raw === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(`marketplace manifest is not valid JSON: ${foundRelPath}`);
  }

  const result = MarketplaceManifestSchema.safeParse(parsedJson);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `marketplace manifest failed schema validation at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown'}`,
    );
  }

  return {
    manifestPath: foundRelPath,
    name: result.data.name,
    displayName: result.data.interface?.displayName,
    plugins: result.data.plugins as MarketplacePluginEntry[],
  };
}

/**
 * Resolve a plugin entry's directory. Local entries are relative to the
 * marketplace root and fenced inside it (a remote manifest must never be
 * able to point at files outside its own clone); git entries materialize
 * into their own clone and their `path` is fenced inside that clone.
 */
export function resolvePluginEntryDir(
  marketplaceDir: string,
  entry: MarketplacePluginEntry,
  materializedGitDir?: string,
): string {
  if (entry.source.source === 'local') {
    return resolveContainedPath(marketplaceDir, entry.source.path);
  }
  if (!materializedGitDir) {
    throw new Error(`git-source plugin ${entry.name} has not been materialized`);
  }
  return resolveContainedPath(materializedGitDir, entry.source.path ?? '.');
}
