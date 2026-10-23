/**
 * The `duya_app` tool namespace (plan 616).
 *
 * ## Why a namespace
 *
 * The host product capabilities (bot channels and other app tools) are
 * served by ONE host-owned in-process MCP
 * server. The model sees them under a single prefix, which is what keeps
 * the base toolset readable: `mcp_duya_app_send_message` says "this is a duya app capability", the same way Codex's `codex_apps__gmail.…`
 * says "this is a connector tool".
 *
 * ## The naming is reversible — deliberately
 *
 * The model-visible name is a pure prefix concatenation:
 *
 *     send_message   ->  mcp_duya_app_send_message
 *
 * No truncation, no hash suffix, no de-duplication suffix. That is
 * because `duya_app` carries no `plugin:` namespace segment, its tool
 * names contain no `__`, and the longest resulting name is far below
 * the 64-character provider limit.
 *
 * Reversibility is what makes the rest of the migration tractable: the
 * renderer, the profile rules, and the permission gate need to resolve
 * app tools from the model-visible name, and a
 * single pure function is a far smaller surface than three parallel
 * prefix checks. It is also why the name must stay in this exact shape:
 * if a tool name ever needed the `__2` de-duplication suffix or the
 * hash truncation, the mapping would stop being invertible and every
 * consumer would need a registry lookup instead.
 *
 * ## Why a closed set, not just the prefix
 *
 * The prefix alone is ambiguous: a user-configured MCP server named
 * `duya_app_lit` produces `mcp_duya_app_lit_<tool>`, which also starts
 * with `mcp_duya_app_`. Resolving against the SET of tools `duya_app`
 * actually serves removes that ambiguity exactly — a name is an app
 * tool only if its base name is one of ours.
 *
 * The set is closed and reviewed on purpose: it lists the app layer's
 * capabilities, and adding a name is a deliberate act.
 */

/** The app server's name — also the namespace segment of its tools. */
export const DUYA_APP_SERVER_NAME = 'duya_app';

/**
 * The model-visible prefix every `duya_app` tool carries.
 *
 * Mirrors the `mcp_` provider prefix the shared MCP name allocator
 * produces (`computeProviderName`), with the server name appended.
 */
export const DUYA_APP_TOOL_PREFIX = `mcp_${DUYA_APP_SERVER_NAME}_`;

/**
 * Every tool name `duya_app` serves.
 *
 * This is the authoritative list of the app layer's capabilities: the
 * bot channels and the remaining
 * product capabilities (plan 616 §3 and §3.1).
 *
 * Keep it in sync with what the app server actually registers — a name
 * here that the server does not serve would let a foreign tool be
 * mistaken for one of ours, and a served name missing here would make
 * one of our tools unrecognisable.
 */
export const DUYA_APP_TOOL_NAMES: readonly string[] = [
  // ── bot channels (plan 616 §3) ──
  'send_message',
  'send_to_agent',
  'post_to_room',
  'ReactToMessage',
  'create_agent',
  'update_agent',
  'manage_routine',
  'list_app_connectors',
  'connect_app',
  // ── remaining host product capabilities (plan 616 §3.1) ──
  'vision_analyze',
  'image_generate',
  'show_widget',
  'read_module',
  'duya_cli',
  'session',
  'MessageSession',
  'SessionSearch',
  'Brief',
  'memory_write',
  'write_stage1_policy',
  'plan',
  'update_state',
  'send_artifact',
];

const APP_TOOL_NAME_SET: ReadonlySet<string> = new Set(DUYA_APP_TOOL_NAMES);

/**
 * Recover the original tool name from a model-visible `duya_app` tool
 * name, or `undefined` when the name belongs to some other provider.
 *
 * The single shared rule for "is this one of our app tools, and which
 * one is it" — used by the desktop renderer (to route a tool to its
 * dedicated row), by the agent profiles (to match allow/deny patterns
 * against the ORIGINAL name), and by the permission gate (to keep the
 * app-specific authorization decisions).
 */
export function resolveAppToolBaseName(modelVisibleName: string): string | undefined {
  if (!modelVisibleName.startsWith(DUYA_APP_TOOL_PREFIX)) {
    return undefined;
  }
  const base = modelVisibleName.slice(DUYA_APP_TOOL_PREFIX.length);
  return APP_TOOL_NAME_SET.has(base) ? base : undefined;
}

/** True when the model-visible name belongs to the `duya_app` server. */
export function isAppToolName(modelVisibleName: string): boolean {
  return resolveAppToolBaseName(modelVisibleName) !== undefined;
}

/**
 * The registry's INTERNAL key for an MCP tool: `mcp__<server>__<tool>`.
 *
 * The registry stores MCP tools under their internal key and shows the
 * model the model-visible name. The permission chain is called with BOTH
 * spellings: the streaming executor with the visible name (the model's
 * own spelling) and the deferred `tool_invoke` dispatcher with the
 * internal key (the registry's storage spelling).
 *
 * A tool addressed by one spelling must be recognised under the other.
 * Otherwise the same rule would apply to a direct call and silently stop
 * applying to the very same tool reached through the catalog — which is
 * exactly the hole the namespace was supposed to close.
 */
export const DUYA_APP_INTERNAL_KEY_PREFIX = `mcp__${DUYA_APP_SERVER_NAME}__`;

/**
 * Recover the original tool name from the registry's internal key, or
 * `undefined` when the key belongs to some other server.
 *
 * The same closed set decides here as for the model-visible name: a key
 * is one of ours only if its tool segment is a tool `duya_app` serves.
 */
export function resolveAppToolBaseNameFromInternalKey(internalKey: string): string | undefined {
  if (!internalKey.startsWith(DUYA_APP_INTERNAL_KEY_PREFIX)) {
    return undefined;
  }
  const base = internalKey.slice(DUYA_APP_INTERNAL_KEY_PREFIX.length);
  return APP_TOOL_NAME_SET.has(base) ? base : undefined;
}

/**
 * The model-visible name of an app tool's original name.
 *
 * The inverse of `appToolOriginalName` for the visible spelling — the
 * namespace is a pure prefix concatenation, so the round trip is exact.
 */
export function appToolVisibleName(originalName: string): string {
  return `${DUYA_APP_TOOL_PREFIX}${originalName}`;
}

/**
 * The name every product rule is written against.
 *
 * The `duya_app` server's tools reach the model under a namespaced name,
 * while rules and profiles may use their original tool names.
 *
 * Resolving once, here, is what stops the namespace from becoming a way
 * around those rules: rules must still match the original tool name. A tool that is not one of ours
 * resolves to itself, so every caller can use this unconditionally.
 *
 * ## It accepts EVERY spelling the tool arrives under
 *
 * The same tool reaches the permission chain under two names: the
 * model-visible one (the streaming executor) and the registry's internal
 * key (the deferred `tool_invoke` dispatcher). Both must resolve to the
 * same original name, or the rules would hold for one call path and not
 * for the other.
 *
 * ## This is a NAME operation, not an identity proof
 *
 * `appToolOriginalName` answers "which original name does this visible
 * name spell?". It does NOT answer "is this tool ours?" — the closed set
 * cannot answer that, because the model-visible name is not a unique key:
 *
 *     server=duya_app, tool=send_message -> mcp_duya_app_send_message
 *     server=duya, tool=app_send_message -> mcp_duya_app_send_message
 *
 * Both spellings land on the same visible name (the allocator folds `__`
 * into `_`), so a THIRD-PARTY server that happens to be named `duya` and
 * exposes a similarly prefixed tool can produce an identical
 * model-visible name. A name-derived answer would then hand a third
 * party's tool the app layer's trust.
 *
 * So name resolution supports rule matching, while authorization decisions
 * use `isTrustedAppToolRegistration`, which reads the identity the HOST
 * registered rather than the name the model sees.
 */
export function appToolOriginalName(toolName: string): string {
  return (
    resolveAppToolBaseName(toolName) ??
    resolveAppToolBaseNameFromInternalKey(toolName) ??
    toolName
  );
}

/**
 * The registration identity of a tool, as the HOST recorded it.
 *
 * This is the trusted half of the namespace. The name says what the model
 * calls the tool; this says who registered it and under which provenance.
 */
export interface AppToolRegistration {
  /** The server that serves the tool — `duya_app` for the app layer. */
  serverName: string;
  /** The tool's name ON that server (the original, pre-namespace name). */
  toolName: string;
  /**
   * The provenance the host registered the server under.
   *
   * `'app'` is the app layer's own bucket: host-owned, not third-party,
   * and NOT the same as `bundled` (which short-circuits the whole
   * permission chain — see plan 616 §C9).
   */
  source: string;
}

/**
 * Is this registration the app layer's own?
 *
 * The check is deliberately narrow: the server must be the app server
 * AND the host must have registered it under the `app` provenance. A
 * third-party server named `duya` is not the app server, and a server
 * named `duya_app` registered from a plugin's config is not `app`
 * provenance either — the name alone never grants trust.
 */
export function isTrustedAppToolRegistration(
  registration: AppToolRegistration | undefined,
): boolean {
  if (!registration) return false;
  return (
    registration.serverName === DUYA_APP_SERVER_NAME &&
    registration.source === APP_TOOL_SOURCE
  );
}

/**
 * The app layer's own provenance bucket.
 *
 * Distinct from `bundled` on purpose. `bundled` means "a packaged
 * external MCP server we trust" and short-circuits the permission chain
 * to `allow`. `app` means "our own product capability" — it must still
 * pass the catastrophic check, the host standing switch and the risk
 * tiers, because the app layer can send messages to users and schedule
 * routines.
 */
export const APP_TOOL_SOURCE = 'app';
