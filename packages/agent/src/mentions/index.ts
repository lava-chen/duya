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
export type MentionTargetKind = 'app' | 'skill' | 'file' | 'mcp';

export interface MentionTarget {
  kind: MentionTargetKind;
  /** For `app`: provider id (e.g. `notion`). Reserved kinds may use paths. */
  id: string;
  /** Human-readable display label (e.g. `Notion`). */
  label: string;
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

  return [
    '## Apps (Connectors)',
    'Apps (Connectors) can be explicitly triggered in user messages in the format `[@App-Name](app://<provider-id>)`. Apps can also be triggered implicitly whenever the context suggests an installed app would help.',
    "An app's tools are either already in your tool list for this turn, or discoverable through the `tool_search` tool.",
    'Do not call list_mcp_resources or similar for apps — use the tools listed above or tool_search.',
    'Connected apps this session:',
    appLines,
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
