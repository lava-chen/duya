/**
 * plugin-marketplaces.ts — the configured marketplace sources as client rows.
 *
 * ## One row per `[marketplaces.<name>]` key
 *
 * A marketplace is a declaration first and a clone second. The row therefore
 * reports what the user configured (kind, URL or path, ref, whether it is
 * hidden) and then what the Host could actually observe about it: a source
 * whose clone is missing reads with `error: "not synced yet"` and
 * `pluginCount: 0`, which is a different statement from one whose catalog has
 * no plugins.
 *
 * ## Why nothing here is cached
 *
 * The clone directory changes under this reader — a refresh, a Desktop sync on
 * a timer, a re-clone after a force-push. A memoized row would let a panel show
 * a count that the install step then refuses to find, so every read walks the
 * directories again. Marketplace lists are a handful of rows; the cost is a
 * directory probe and one JSON parse per source.
 */

import * as fs from 'node:fs';

import type {
  HostMarketplaceIssue,
  HostMarketplaceView,
} from '@duya/agent-protocol/plugin-management';
import { resolveSourceUrls, resolveConfiguredMarketplaceDir } from '@duya/plugin-core/marketplace/git-source';
import type { MarketplaceSourceConfig } from '@duya/plugin-core/marketplace/git-source';
import { readMarketplaceManifest } from '@duya/plugin-core/marketplace/manifest';
import { isDefaultOfficialSource } from '@duya/plugin-core/marketplace/official-seeds';

/** The writable form of the contract row, used only while the probe runs. */
type MutableMarketplaceView = { -readonly [K in keyof HostMarketplaceView]: HostMarketplaceView[K] };

/**
 * Describe one configured source, including a `removed` tombstone when the
 * caller asks for it explicitly — a mutation that removed a source reports the
 * row it removed, and only this function can render a key the table no longer
 * holds.
 */
export function buildMarketplaceView(
  marketplacesRoot: string,
  name: string,
  config: MarketplaceSourceConfig,
): HostMarketplaceView {
  // Built mutably, returned as the read-only contract: the row fills in as the
  // probe walks the file system, and the last write of each field wins.
  const view: MutableMarketplaceView = {
    name,
    displayName: name,
    kind: config.source,
    hidden: config.hidden === true,
    pluginCount: 0,
    isDefault: isDefaultOfficialSource(name),
  };
  if (config.source === 'git') {
    const first = resolveSourceUrls(config)[0];
    if (first !== undefined) view.url = first;
  } else if (config.path !== undefined) {
    view.path = config.path;
  }
  if (config.ref !== undefined) view.ref = config.ref;
  if (config.addedAt !== undefined) view.addedAt = config.addedAt;
  if (config.displayName !== undefined) view.displayName = config.displayName;

  const dir = resolveConfiguredMarketplaceDir(marketplacesRoot, name, config);
  if (dir === null) {
    view.error = 'no source configured';
    return view;
  }
  if (!fs.existsSync(dir)) {
    view.error = 'not synced yet';
    return view;
  }

  let manifest: ReturnType<typeof readMarketplaceManifest>;
  try {
    manifest = readMarketplaceManifest(dir);
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
    return view;
  }
  if (manifest === null) {
    view.error = 'no marketplace.json found';
    return view;
  }

  // The manifest's own label wins: it is what the source calls itself, and a
  // configured `displayName` is the user's fallback for a source with none.
  const label = manifest.displayName ?? manifest.name;
  if (label !== undefined) view.displayName = label;
  view.pluginCount = manifest.plugins.length;
  return view;
}

export interface MarketplaceViewBuild {
  readonly views: readonly HostMarketplaceView[];
  readonly issues: readonly HostMarketplaceIssue[];
}

/**
 * Describe every configured marketplace.
 *
 * `removed` entries are tombstones that keep a pre-seeded source from coming
 * back on the next launch; they are configuration noise, not sources, so the
 * list omits them — the same rule the Desktop's marketplace tab applies.
 */
export function buildMarketplaceViews(
  marketplacesRoot: string,
  marketplaces: Readonly<Record<string, MarketplaceSourceConfig>>,
): MarketplaceViewBuild {
  const views: HostMarketplaceView[] = [];
  const issues: HostMarketplaceIssue[] = [];
  for (const [name, config] of Object.entries(marketplaces)) {
    if (config.removed === true) continue;
    const view = buildMarketplaceView(marketplacesRoot, name, config);
    if (view.error !== undefined) issues.push({ marketplace: name, error: view.error });
    views.push(view);
  }
  return { views, issues };
}
