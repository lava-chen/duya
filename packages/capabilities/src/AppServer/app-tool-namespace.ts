/**
 * The `duya_app` tool namespace (plan 616).
 *
 * ## Why a namespace
 *
 * The product capabilities that leave the base toolset (canvas, the bot
 * channels, the browser) are served by ONE host-owned in-process MCP
 * server. The model sees them under a single prefix, which is what keeps
 * the base toolset readable: `mcp_duya_app_canvas_manage` says "this is
 * a duya app capability", the same way Codex's `codex_apps__gmail.…`
 * says "this is a connector tool".
 *
 * ## The naming is reversible — deliberately
 *
 * The model-visible name is a pure prefix concatenation:
 *
 *     canvas_manage  ->  mcp_duya_app_canvas_manage
 *     browser        ->  mcp_duya_app_browser
 *
 * No truncation, no hash suffix, no de-duplication suffix. That is
 * because `duya_app` carries no `plugin:` namespace segment, its tool
 * names contain no `__`, and the longest resulting name is far below
 * the 64-character provider limit.
 *
 * Reversibility is what makes the rest of the migration tractable: the
 * renderer, the profile rules, and the permission gate all need to
 * recognise "this is the canvas tool" from the model-visible name, and a
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
 * The set is closed and reviewed on purpose: it is the list of
 * capabilities the app layer owns, and adding to it is a deliberate act
 * (a new app tool declares itself here).
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
 * canvas family, the bot channels, the browser, and the remaining
 * product capabilities (plan 616 §3 and §3.1).
 *
 * Keep it in sync with what the app server actually registers — a name
 * here that the server does not serve would let a foreign tool be
 * mistaken for one of ours, and a served name missing here would make
 * one of our tools unrecognisable.
 */
export const DUYA_APP_TOOL_NAMES: readonly string[] = [
  // ── canvas (plan 616 §3) ──
  'canvas_manage',
  'canvas_create_element',
  'canvas_delete_element',
  'canvas_move_element',
  'canvas_resize_element',
  'canvas_style_element',
  'canvas_fill_content',
  'canvas_list_elements',
  'canvas_get_context',
  'canvas_find_empty_space',
  'canvas_auto_layout',
  'canvas_apply_layout',
  'canvas_capture',
  'canvas_get_knowledge',
  'canvas_data_source',
  'database_manage',
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
  // ── browser + the remaining product capabilities (plan 616 §3.1) ──
  'browser',
  'computer_use',
  'computer_cua',
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
 * canvas tools' unconditional allow).
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
