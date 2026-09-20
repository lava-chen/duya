/**
 * Unified turn-mention framework (Plan 450 Phase G) — codex parity.
 *
 * codex treats every composer @-mention as one of a family of typed targets
 * (`app://`, `mcp://`, `plugin://`, `skill://`, filesystem) collected per
 * turn (`core/src/plugins/mentions.rs`), injected as structured context
 * (`core/src/context/apps_instructions.rs`), and mapped to per-turn tool
 * activation (`core/src/session/turn.rs`). duya grows the same framework
 * incrementally: `app` is implemented today; `skill` / `file` / `mcp`
 * targets reserve the interface and return no injections yet.
 *
 * Two surfaces fall out of a collected mention:
 *   1. A per-turn `TurnInjection` (transient, promptContexts rail) — what
 *      the user explicitly named THIS run.
 *   2. A persistent system-prompt section — the always-on capability map so
 *      the model can also trigger apps implicitly (codex's developer-role
 *      "Apps (Connectors)" block).
 */

/** Typed mention target. `id` is the scheme-qualified target key without the scheme. */
export type MentionTargetKind = 'app' | 'skill' | 'file' | 'mcp' | 'plugin';

export interface MentionTarget {
  kind: MentionTargetKind;
  /** For `app`: provider id (e.g. `notion`). Reserved kinds may use paths. */
  id: string;
  /** Human-readable display label (e.g. `Notion`). */
  label: string;
}

/** Structured plugin mention from the renderer (@ popover lists plugins). */
export interface PluginMention {
  pluginId: string;
  name: string;
  description?: string;
  /** App connector ids the plugin declares (`.app.json` / `apps/connections.json`). */
  appConnections: string[];
  /** MCP server names the plugin contributes. */
  mcpServers: string[];
  /** Skill names the plugin contributes (from its `skills/` directory). */
  skillNames: string[];
}

/** A transient context block injected for the turn that mentioned a target. */
export interface TurnInjection {
  /** Envelope tag without angle brackets, e.g. `connector-activation`. */
  envelope: string;
  /** Full body text (rendered inside `<envelope>...</envelope>`). */
  body: string;
}

/** Minimal tool-descriptor shape the mention module needs (no schemas). */
export interface AppToolSummary {
  provider: string;
  /** Display label (e.g. `Notion`); falls back to the provider id. */
  providerLabel?: string;
  /** LLM-visible tool name (e.g. `remote_notion_search`). */
  name: string;
}

/**
 * Build the per-turn connector-activation injection for @-mentioned apps.
 *
 * codex parity note: a mention changes tool exposure, not capability text —
 * this block only tells the model which apps the user explicitly named and
 * what is actually available. When a mentioned provider has zero cached tool
 * descriptors we deliberately do NOT claim it is "not connected" (the cache
 * is best-effort and can be stale after a failed descriptor fetch); the
 * wording stays neutral and points at re-authorization only as a possibility.
 */
export function collectConnectorActivationInjection(
  selectedProviders: readonly string[],
  descriptors: readonly AppToolSummary[],
): TurnInjection | null {
  const selected = selectedProviders.filter((p) => typeof p === 'string' && p.trim().length > 0);
  if (selected.length === 0) return null;

  const lines = selected.map((provider) => {
    const tools = descriptors.filter((d) => d.provider === provider);
    const label = tools.find((d) => d.providerLabel)?.providerLabel ?? provider;
    if (tools.length > 0) {
      const names = tools.map((d) => d.name).join(', ');
      return `- [${label}](app://${provider}): ${tools.length} tool(s) available this run: ${names}`;
    }
    return `- [${label}](app://${provider}): no tools exposed this run — the connection may need re-authorization; if the user asks for ${label} actions, suggest reconnecting in Settings → Extensions → Connections`;
  });

  return {
    envelope: 'connector-activation',
    body: [
      'The user explicitly mentioned these app connections in their message:',
      ...lines,
      'Prefer these apps\' tools for tasks matching their capabilities; other tools remain discoverable through tool_search.',
    ].join('\n'),
  };
}

/**
 * Build the persistent "Apps (Connectors)" system-prompt section.
 *
 * codex parity: `core/src/context/apps_instructions.rs` renders a
 * developer-role block whenever any accessible+enabled app exists, teaching
 * the `[$app-name](app://id)` mention syntax and pointing at tool_search —
 * so the model can trigger apps implicitly, not only on turns where the
 * user happened to @-mention one. Returns null when no app is connected,
 * keeping the system prompt unchanged for users without connections
 * (prompt-cache friendly: the section only changes when the set of
 * connected apps or their tools changes).
 */
export function buildAppsSystemSection(
  descriptors: readonly AppToolSummary[],
): string | null {
  if (descriptors.length === 0) return null;

  const byProvider = new Map<string, { label: string; tools: string[] }>();
  for (const d of descriptors) {
    if (!d.provider) continue;
    const entry = byProvider.get(d.provider) ?? {
      label: d.providerLabel || d.provider,
      tools: [],
    };
    entry.tools.push(d.name);
    byProvider.set(d.provider, entry);
  }
  if (byProvider.size === 0) return null;

  const appLines = [...byProvider.entries()]
    .map(([id, { label, tools }]) => `- [${label}](app://${id}): ${tools.join(', ')}`)
    .join('\n');

  // Plan 498: "help the user connect" contract, aligned with grok-bot's
  // connector system-prompt section (system-prompt.ts:185-186, 165, 191,
  // 245). DuYA's model cannot install connectors itself — the user connects
  // from Settings or through the auth card — so the model's role is: prefer
  // connectors over browser workarounds, name missing services plainly,
  // point at the real connect path, never fabricate authorization links,
  // and never bypass a service whose authorization is pending.
  return [
    '## Apps (Connectors)',
    'Apps (Connectors) can be explicitly triggered in user messages in the format `[@App-Name](app://<provider-id>)`. Apps can also be triggered implicitly whenever the context suggests an installed app would help.',
    "An app's tools are either already in your tool list for this turn, or discoverable through the `tool_search` tool.",
    'Do not call list_mcp_resources or similar for apps — use the tools listed above or tool_search.',
    'Connected apps this session:',
    appLines,
    'Helping the user connect apps:',
    "- A connected app's tools are the best way to reach that service — structured data instead of a browser session that rots. Prefer them over browser or computer-use tools for services that have a connector above.",
    '- When a task needs a service that is NOT in the list above: name the service in plain text and ask the user to connect it in Settings → Extensions → Connections. Never compose or paste an install or authorization URL.',
    '- Do not reach a service through the browser or other workarounds while its authorization is pending, and do not quietly bypass a failing connector — say so and let the user connect or re-authorize instead.',
    "- If an app tool call fails with an authorization error, a re-authorization card is shown to the user automatically: finish unrelated work, then end your turn — a follow-up message will arrive so you can re-issue the call with the same arguments. Don't paste a link or re-run the call meanwhile.",
    '- When a recurring task would benefit from a service that is not connected, surface that connector to the user instead of silently working around it.',
  ].join('\n');
}

// Reserved for the next framework milestones (plan 450 Phase H+):
//   - collectFileInjection(target: MentionTarget)  — file:// attachment pointer
// See codex `core/src/plugins/render.rs` for the injection-shape reference.

import { join } from 'node:path';
import { getSkillRegistry } from '../skills/registry.js';
import type { ToolUseContext } from '../types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extract explicitly-referenced skill names from the raw prompt text
 * (plan 535 Phase B — codex `collect_explicit_skill_mentions` parity).
 *
 * Two recognition sources, in priority order:
 *   1. `$name` exact syntax — the codex-style handwritten reference. The
 *      token charset is `[A-Za-z0-9_-]{2,64}` and must not be preceded by
 *      another word character or `$`, so `$5`/`$10`-style prices and
 *      `foo$bar` identifiers are ignored; anything that does not resolve
 *      against the registry (prices, unknown skills) drops out silently.
 *   2. `skill://name` targets — both the renderer-rewritten markdown form
 *      `[/name](skill://name)` and bare URIs.
 *
 * Handwritten `/name` stays with the popover path (options.mentionedSkills),
 * which is the established injection form — no new `/name` parsing here.
 *
 * Names are resolved case-insensitively through the skill registry and
 * returned as canonical registered names, deduplicated. Visibility rules
 * (hidden / disabled / conditional-pending) remain with
 * `collectSkillInjections` — the single fail-closed choke point.
 */
export function extractExplicitSkillMentions(promptText: string): string[] {
  if (!promptText || promptText.trim().length === 0) return [];

  const registry = getSkillRegistry();
  const resolved = new Set<string>();
  const add = (token: string): void => {
    const canonical = registry.resolveName(token);
    if (canonical) resolved.add(canonical);
  };

  // 1. `$name` exact syntax.
  const dollar = /\$([A-Za-z0-9_-]{2,64})/g;
  for (const match of promptText.matchAll(dollar)) {
    // Lookbehind guard: not preceded by a word char or another `$`
    // (rejects `foo$bar`, `$$name`), and must contain at least one letter
    // (rejects pure-numeric prices like `$20` even if a skill were
    // named "20" — a numeric skill name is not addressable by design).
    const start = match.index ?? 0;
    const prev = start > 0 ? promptText[start - 1] : '';
    if (prev && /[A-Za-z0-9_$]/.test(prev)) continue;
    const token = match[1]!;
    if (!/[A-Za-z]/.test(token)) continue;
    add(token);
  }

  // 2a. Renderer-rewritten markdown form: `[/name](skill://name)`.
  const markdownLink = /\[[^\]]*\]\(\s*skill:\/\/([^)\s]+)\s*\)/g;
  for (const match of promptText.matchAll(markdownLink)) {
    add(match[1]!);
  }

  // 2b. Bare `skill://name` URIs.
  const bareUri = /(?<![A-Za-z0-9_/-])skill:\/\/([A-Za-z0-9_-]+)/g;
  for (const match of promptText.matchAll(bareUri)) {
    add(match[1]!);
  }

  return Array.from(resolved);
}

/**
 * Merge popover-mentioned skills with explicitly-extracted ones (plan 535
 * Phase B wiring). Popover names come first (explicit UI selection is the
 * highest-signal source), extracted names follow in registry-resolution
 * order; dedupe is case-insensitive on the raw name so `$PDF` and a
 * popover `PDF` collapse to one entry.
 */
export function mergeSkillMentionSources(
  popoverNames: readonly string[],
  explicitNames: readonly string[],
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [...popoverNames, ...explicitNames]) {
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(name.trim());
  }
  return merged;
}

/**
 * Collect `<skill>` fragment injections for the `/name` skills mentioned
 * this turn (Plan 450 Phase H) — codex `UserInput::Skill` +
 * `load_skill_prompts` parity.
 *
 * Names are resolved against the agent's OWN skill registry (alias-aware);
 * renderer-supplied names are hints, never paths, so nothing from the
 * composer is trusted as a filesystem location. Loading goes through
 * `skill.getPromptForCommand` — the exact same source the Skill tool uses —
 * so the injected body matches what an explicit Skill invocation would see.
 * Skills that are hidden, model-invocation-disabled, conditional-pending, or
 * disabled are silently skipped (fail-open for the user's message text,
 * fail-closed for the injection).
 */
export async function collectSkillInjections(
  selectedSkills: readonly unknown[],
): Promise<TurnInjection[]> {
  const names = selectedSkills.filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  if (names.length === 0) return [];

  const registry = getSkillRegistry();
  const context: ToolUseContext = {
    toolUseId: crypto.randomUUID(),
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      tools: [],
      commands: [],
      mainLoopModel: '',
      mcpClients: [],
    },
  };

  const injections: TurnInjection[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const skill = registry.get(name.trim());
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    // Same visibility rules as the `<available_skills>` catalog
    // (registry.listModelInvocable): a skill the model cannot load must not
    // be force-injected either.
    if (
      skill.isHidden
      || skill.disableModelInvocation
      || skill.isConditional
      || skill.isEnabled?.() === false
    ) {
      continue;
    }

    let body: string;
    try {
      body = await skill.getPromptForCommand('', context);
    } catch {
      continue;
    }
    if (!body) continue;

    const location = skill.skillRoot ? join(skill.skillRoot, 'SKILL.md') : undefined;
    injections.push({
      envelope: 'skill',
      body: [
        `<name>${escapeXml(skill.name)}</name>`,
        ...(location ? [`<location>${escapeXml(location)}</location>`] : []),
        '',
        body,
      ].join('\n'),
    });
  }
  return injections;
}

/**
 * Build the per-turn plugin-activation injection for @-mentioned plugins.
 *
 * Codex parity (`core/src/plugins/render.rs` `render_explicit_plugin_instructions`):
 * a plugin mention is NOT a tool registration — it is a hint block that tells
 * the model which of the plugin's capabilities (apps, MCP servers, skills)
 * are usable this turn. App tools are activated through `mentionedProviders`
 * (exposure promotion, wired renderer-side); MCP tools are already
 * Direct-exposed in the tool list; skills are invoked via `/name` or the
 * Skill tool. Declared-but-unconnected apps are labelled honestly so the
 * model can point the user at re-authorization instead of hallucinating.
 */
export function collectPluginInjections(
  mentions: readonly PluginMention[],
  descriptors: readonly AppToolSummary[],
): TurnInjection | null {
  const valid = mentions.filter(
    (m) => m && typeof m.pluginId === 'string' && m.pluginId.length > 0,
  );
  if (valid.length === 0) return null;

  const byProvider = new Map(descriptors.map((d) => [d.provider, d]));

  const lines = valid.map((m) => {
    const name = m.name || m.pluginId;
    const detail: string[] = [];
    if (m.appConnections.length > 0) {
      const ready = m.appConnections.filter((id) => byProvider.has(id));
      const notReady = m.appConnections.filter((id) => !byProvider.has(id));
      if (ready.length > 0) {
        detail.push(`apps available this session: ${ready.map((id) => `\`${id}\``).join(', ')}`);
      }
      if (notReady.length > 0) {
        detail.push(`apps not connected/authorized: ${notReady.map((id) => `\`${id}\``).join(', ')}`);
      }
    }
    if (m.mcpServers.length > 0) {
      detail.push(`MCP servers: ${m.mcpServers.map((s) => `\`${s}\``).join(', ')}`);
    }
    if (m.skillNames.length > 0) {
      detail.push(`skills (invoke via /name or the Skill tool): ${m.skillNames.map((s) => `\`${s}\``).join(', ')}`);
    }
    const detailText = detail.length > 0 ? ` (${detail.join('; ')})` : '';
    return `- [${name}](plugin://${m.pluginId}): ${detailText || 'no callable capabilities exposed this run'}`;
  });

  return {
    envelope: 'plugin-activation',
    body: [
      'The user explicitly mentioned these plugins in their message. Prefer the capabilities associated with them for this turn:',
      ...lines,
      'Plugins are not invoked directly — use their underlying app tools, MCP tools, or skills to help solve the task.',
    ].join('\n'),
  };
}
