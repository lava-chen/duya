/**
 * Plugin mention rewriting (@ → installed plugins).
 *
 * The composer `@` popover lists installed plugins (one row per plugin,
 * regardless of how many apps/MCP servers/skills it contributes). Selecting
 * a plugin inserts `@<pluginId> ` into the textarea. Submitted verbatim,
 * that bare token would reach the model as prose; this helper rewrites it
 * into a codex-style structured link `[@Name](plugin://pluginId)` the model
 * can resolve, and returns structured mention data for per-turn injection.
 *
 * Codex parity (`codex-rs/core/src/plugins/mentions.rs` + `injection.rs`):
 *   - a plugin mention is a typed target (`plugin://` scheme);
 *   - the app connectors the plugin declares are ALSO activated this turn
 *     (duya: they flow into `mentionedProviders` so the existing exposure
 *     promotion + `<connector-activation>` reminder applies — the user asked
 *     for exactly this);
 *   - MCP servers / skills are NOT separately activated — the agent-side
 *     `<plugin-activation>` block lists them so the model knows they exist
 *     (MCP tools are Direct-exposed already; skills are picked via `/`).
 *
 * Fail-open: tokens that do not resolve against `availablePlugins` pass
 * through untouched (prose like "email me @home" stays prose), mirroring
 * `rewriteAppMentionTokens`.
 */

/** Structured capability summary for a mentioned plugin (transported to the agent). */
export interface PluginMentionCapabilities {
  /** Installed-plugin id (never contains `@` — marketplace lives in a separate field). */
  pluginId: string;
  /** Display name (e.g. `WeChat Pay Connector`). */
  name: string;
  /** Manifest description, when present. */
  description?: string;
  /** App connector ids the plugin declares (`.app.json` / `apps/connections.json`). */
  appConnections: string[];
  /** MCP server names the plugin contributes. */
  mcpServers: string[];
  /** Skill names the plugin contributes (from its `skills/` directory). */
  skillNames: string[];
}

/** Result of {@link rewritePluginMentionTokens}. */
export interface PluginMentionRewrite {
  /** Content with bare `@pluginId` tokens replaced by `[@Name](plugin://id)` links. */
  content: string;
  /** Mentioned plugins (structured), first-seen order. */
  mentionedPlugins: PluginMentionCapabilities[];
  /**
   * Provider ids for per-turn app activation: `existingProviders` plus every
   * app connector the mentioned plugins declare that is currently connected.
   * Callers feed this into the existing `mentionedProviders` transport so the
   * plugin's apps get exposure promotion and the connector-activation reminder.
   */
  mergedProviders: string[];
}

/**
 * Rewrite bare `@<pluginId>`/`@<pluginName>` tokens into `[@Name](plugin://id)`
 * links and collect structured mentions. Idempotent: existing
 * `[@name](plugin://id)` links are recognized and never double-encoded.
 *
 * @param content            composer text (post app-mention rewriting).
 * @param availablePlugins   enabled installed plugins with capability summaries.
 * @param connectedProviders provider ids with a live connection (used to
 *                           decide which of the plugin's apps get activated).
 * @param existingProviders  provider ids already mentioned this turn (from the
 *                           app-mention pass) — preserved and merged.
 */
export function rewritePluginMentionTokens(
  content: string,
  availablePlugins: PluginMentionCapabilities[],
  connectedProviders: string[],
  existingProviders: string[],
): PluginMentionRewrite {
  if (!content || !content.includes('@') || availablePlugins.length === 0) {
    return { content, mentionedPlugins: [], mergedProviders: [...existingProviders] };
  }

  const connected = new Set(connectedProviders);
  const byIdOrName = new Map<string, PluginMentionCapabilities>();
  for (const plugin of availablePlugins) {
    if (!plugin.pluginId) continue;
    byIdOrName.set(plugin.pluginId.toLowerCase(), plugin);
    if (plugin.name?.trim()) {
      const name = plugin.name.trim();
      byIdOrName.set(name.toLowerCase(), plugin);
      // Slugified display name (codex `plugin_mention_name` parity): "MCP
      // Search" is mentionable as `@mcp-search` since bare tokens cannot
      // contain spaces.
      const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-');
      if (slug && slug !== name.toLowerCase()) byIdOrName.set(slug, plugin);
    }
  }

  const seenPlugins = new Set<string>();
  const mentionedPlugins: PluginMentionCapabilities[] = [];
  const record = (plugin: PluginMentionCapabilities) => {
    if (seenPlugins.has(plugin.pluginId)) return;
    seenPlugins.add(plugin.pluginId);
    mentionedPlugins.push(plugin);
  };

  // Same shape as rewriteAppMentionTokens: an already-encoded link (kept
  // verbatim, only counted) or a bare word-boundary `@token`. Boundary char
  // is consumed by the bare alternative and re-emitted verbatim. CJK chars
  // act as boundaries so `看看我的@wechat-pay` rewrites without a space.
  const re = /\[@([^\]]+)\]\((plugin:\/\/[^)\s]+)\)|(?:^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/gu;
  let out = '';
  let lastIndex = 0;
  for (const match of content.matchAll(re)) {
    const index = match.index ?? 0;
    out += content.slice(lastIndex, index);

    if (match[1] !== undefined && match[2] !== undefined) {
      // Already-linked form: `[@name](plugin://id)`.
      const linkedId = match[2].slice('plugin://'.length).toLowerCase();
      const resolved = byIdOrName.get(linkedId);
      if (resolved) record(resolved);
      // Preserve the link exactly as written — never double-encode.
      out += match[0];
    } else if (match[3] !== undefined) {
      // Bare token: boundary char (group excludes it from the token itself)
      // + `@name`. The boundary char is `match[0][0]` when not at string start.
      const boundary = match[0].startsWith('@') ? '' : match[0][0];
      const resolved = byIdOrName.get(match[3].toLowerCase());
      if (resolved) {
        record(resolved);
        out += `${boundary}[@${resolved.name || resolved.pluginId}](plugin://${resolved.pluginId})`;
      } else {
        out += match[0];
      }
    }
    lastIndex = index + match[0].length;
  }
  out += content.slice(lastIndex);

  // Merge: existing providers first, then this plugin's connected apps.
  const seenProviders = new Set(existingProviders);
  const mergedProviders = [...existingProviders];
  for (const plugin of mentionedPlugins) {
    for (const appId of plugin.appConnections) {
      if (connected.has(appId) && !seenProviders.has(appId)) {
        seenProviders.add(appId);
        mergedProviders.push(appId);
      }
    }
  }

  return { content: out, mentionedPlugins, mergedProviders };
}
