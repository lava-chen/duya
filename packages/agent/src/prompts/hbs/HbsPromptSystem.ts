/**
 * HbsPromptSystem — Plan 550.
 *
 * Thin wrapper that pairs the `HbsPromptRenderer` with the static-section
 * boundary token so the existing `PromptSystem` can defer to a `.hbs`
 * template. Designed as a one-shot replacement for the
 * `general/sections/*.ts` chain when a config sets `staticTemplate`.
 *
 * Behaviour contract (locked by the byte-level diff test in
 * `tests/unit/prompts/hbs/general-prompt-byte-diff.test.ts`):
 *
 *   - The renderer is bound to `<packages/agent/src/prompts/assets>` so
 *     templates can be referenced by short relative paths (e.g.
 *     `general/system-prompt.md.hbs`).
 *   - `buildStaticSections(context)` returns an array of string segments
 *     matching what the legacy `PromptSystem` would have produced, joined
 *     with a leading newline so the
 *     `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` token sits cleanly between the
 *     static and dynamic halves.
 *   - Dynamic sections are out of scope here — 1c owns that path.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PromptContext, SystemPrompt } from '../types.js';
import { asSystemPrompt, CYBER_RISK_INSTRUCTION, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, TOOL_NAMES } from '../types.js';
import { buildLanguageGuidance } from '../language-guidance.js';
import { getPlatformHint } from '../platformHints.js';
import { HbsPromptRenderer } from './HandlebarsRenderer.js';

const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');

/**
 * Map a `PromptContext` to the variables a `.hbs` template expects.
 *
 * The mapping is intentionally explicit (one entry per template variable)
 * to make it easy to grep the contract between the TS world and the
 * template world. Tests under `tests/unit/prompts/hbs/` pin the names.
 */
export function mapPromptContextToHbs(ctx: PromptContext): Record<string, unknown> {
  const outputStyleConfig = ctx.outputStyleConfig;
  const isWindows = ctx.platform === 'win32';
  const hasTodoTool =
    ctx.enabledTools.has(TOOL_NAMES.TODO) ||
    ctx.enabledTools.has(TOOL_NAMES.TASK) ||
    ctx.enabledTools.has(TOOL_NAMES.TODO_WRITE);
  const hasEmbeddedSearchTools = ctx.hasEmbeddedSearchTools ?? false;
  const isReplModeEnabled = ctx.isReplModeEnabled ?? false;
  const hasPowerShellTool = ctx.enabledTools.has('powershell');
  const hasDuyaCli = ctx.enabledTools.has('duya_cli');
  // The desktop section is gated on `duya_cli` (the legacy duyaDesktopContext
  // section uses the same heuristic — `duya_cli` is the proxy for
  // "running inside the Duya desktop app" because the CLI control plane
  // is desktop-only).
  const isDesktopSurface = hasDuyaCli;
  const shellToolsLabel = hasPowerShellTool
    ? `${TOOL_NAMES.BASH} or ${TOOL_NAMES.POWERSHELL}`
    : TOOL_NAMES.BASH;

  const fileLinkExample = isWindows
    ? '[app.py](C:/project/src/app.py:12). Write drive paths directly, exactly as they exist on disk — NEVER add an `/abs/` or `/abs/path` prefix to a Windows path'
    : '[app.py](/abs/path/app.py:12)';
  const spacedExample = isWindows
    ? '[My Report.md](<C:/Users/me/My Project/My Report.md:3>)'
    : '[My Report.md](</abs/path/My Project/My Report.md:3>)';
  const imageRule = isWindows
    ? '* **To embed a local image, use a markdown image with an absolute Windows drive path and forward slashes**: `![alt](C:/path/to/image.png)` (e.g. `![chart](C:/Users/me/plot.png)`). Use forward slashes, never backslashes — `E:\\4.png` is not rendered correctly. Never write an `/abs/` or `/abs/path` prefix in front of the drive letter.'
    : '* **To embed a local image, use a markdown image with an absolute path and forward slashes**: `![alt](/abs/path/image.png)`. Verify the file exists at the path you cite.';

  const providedToolSubitems = [
    `To read files use ${TOOL_NAMES.READ}`,
    `To edit files use ${TOOL_NAMES.EDIT}. Prefer ${TOOL_NAMES.EDIT} when you have a single file and an exact, unique old_string to replace. Use apply_patch for multi-file changes or when matching must tolerate context drift (the current file may differ from what you read earlier). Do not default to one over the other — pick the tool that fits the change.`,
    `To create files use ${TOOL_NAMES.WRITE}`,
    ...(hasEmbeddedSearchTools
      ? []
      : [
          `To search for files use ${TOOL_NAMES.GLOB}`,
          `To search content use ${TOOL_NAMES.GREP}`,
        ]),
    `Reserve using ${shellToolsLabel} for system commands that require shell execution. Use ${TOOL_NAMES.BASH} for Unix-style shell commands and ${TOOL_NAMES.POWERSHELL} for Windows-native PowerShell commands when available.`,
  ];

  const outputStyleClause =
    outputStyleConfig !== null && outputStyleConfig !== undefined
      ? 'according to your "Output Style" below, which describes how you should respond to user queries. '
      : 'with a wide range of tasks including answering questions, providing explanations, creative work, analysis, and executing actions. ';

  // Dynamic-section inputs (Plan 550 1c). Each is the precomputed string
  // the .hbs templates need; empty strings cause the `{{#if}}` blocks to
  // skip their body, matching the legacy `return null` short-circuits.
  const languageGuidance = ctx.language ? buildLanguageGuidance(ctx.language) : '';
  const platformHint = getPlatformHint(ctx.communicationPlatform) ?? '';
  const outputStylePrompt =
    ctx.outputStyleConfig && ctx.outputStyleConfig.prompt && ctx.outputStyleConfig.prompt.trim()
      ? ctx.outputStyleConfig.prompt
      : '';
  const outputStyleName = ctx.outputStyleConfig?.name ?? '';
  const mcpInstructionBlocks =
    ctx.mcpServers && ctx.mcpServers.length > 0
      ? ctx.mcpServers
          .filter(
            (server): server is { name: string; instructions?: string } =>
              'instructions' in server && server.instructions !== undefined,
          )
          .map(server => `## ${server.name}\n${server.instructions}`)
          .join('\n\n')
      : '';
  const hasVisionTool = ctx.enabledTools.has(TOOL_NAMES.VISION);
  // Plan 550 1d-rest — scratchpad_dir is the precomputed string the
  // dynamic/scratchpad.hbs template needs; empty string causes the
  // `{{#if}}` block to skip its body, matching the legacy
  // `return null` short-circuit in getScratchpadSection.
  const scratchpadDir = ctx.scratchpadDir ?? '';
  const hasSessionSearchTool = ctx.enabledTools.has(TOOL_NAMES.SESSION_SEARCH);
  // Plan 550 1d-rest — session-guidance precomputed booleans / strings.
  // Each conditional paragraph in getSessionGuidanceSection becomes a
  // `{{#if}}` block in the .hbs; the boolean fields gate visibility and
  // the string fields carry the tool-name / search-tools label so a tool
  // rename propagates via TOOL_NAMES.
  const hasAskUserQuestion = ctx.enabledTools.has(TOOL_NAMES.ASK_USER_QUESTION);
  const hasAgentTool = ctx.enabledTools.has(TOOL_NAMES.SUBAGENT);
  const hasSkills = ctx.enabledTools.has(TOOL_NAMES.SKILL);
  const isNonInteractiveSession = ctx.isNonInteractiveSession ?? false;
  const isForkSubagentEnabled = ctx.isForkSubagentEnabled ?? false;
  const searchTools = hasEmbeddedSearchTools
    ? `\`find\` or \`grep\` via the ${TOOL_NAMES.BASH} tool`
    : `the ${TOOL_NAMES.GLOB} or ${TOOL_NAMES.GREP}`;
  const isSkillSearchEnabled = ctx.isSkillSearchEnabled ?? false;
  const hasDiscoverSkillsTool = ctx.enabledTools.has(TOOL_NAMES.DISCOVER_SKILLS);
  const showDiscoverSkillsGuidance = isSkillSearchEnabled && hasDiscoverSkillsTool;
  const isVerificationAgentEnabled = ctx.isVerificationAgentEnabled ?? false;
  const showVerificationAgentSection = isVerificationAgentEnabled && hasAgentTool;

  return {
    ctx,
    outputStyleConfig,
    outputStyleClause,
    cyber_risk_instruction: CYBER_RISK_INSTRUCTION,
    isWindows,
    platform: ctx.platform,
    shell: ctx.shell,
    hasTodoTool,
    todo_tool_name: TOOL_NAMES.TODO,
    hasEmbeddedSearchTools,
    isReplModeEnabled,
    hasPowerShellTool,
    hasDuyaCli,
    isDesktopSurface,
    shellToolsLabel,
    providedToolSubitems,
    ask_user_question_tool: TOOL_NAMES.ASK_USER_QUESTION,
    fileLinkExample,
    spacedExample,
    imageRule,
    // Plan 550 1c — dynamic-section variables
    language_guidance: languageGuidance,
    platform_hint: platformHint,
    output_style_prompt: outputStylePrompt,
    output_style_name: outputStyleName,
    mcp_instruction_blocks: mcpInstructionBlocks,
    has_vision_tool: hasVisionTool,
    vision_tool_name: TOOL_NAMES.VISION,
    scratchpad_dir: scratchpadDir,
    has_session_search_tool: hasSessionSearchTool,
    // session-guidance
    has_ask_user_question: hasAskUserQuestion,
    has_agent_tool: hasAgentTool,
    has_skills: hasSkills,
    is_non_interactive_session: isNonInteractiveSession,
    has_embedded_search_tools: hasEmbeddedSearchTools,
    is_fork_subagent_enabled: isForkSubagentEnabled,
    search_tools: searchTools,
    show_discover_skills_guidance: showDiscoverSkillsGuidance,
    show_verification_agent_section: showVerificationAgentSection,
    TOOL_NAMES,
  };
}

export interface HbsPromptSystemOptions {
  /** Override the assets root. Default: `<packages/agent/src/prompts/assets>`. */
  assetsRoot?: string;
}

/**
 * Render a `.hbs` template using the standard section context mapper.
 *
 * The class is intentionally small: it owns the renderer (and therefore
 * its compile cache), and exposes `renderStaticTemplate` so a `PromptSystem`
 * can hand it one of the existing static-section names. The caller is
 * still responsible for assembling dynamic sections.
 */
export class HbsPromptSystem {
  private readonly renderer: HbsPromptRenderer;
  private readonly assetsRoot: string;

  constructor(options: HbsPromptSystemOptions = {}) {
    this.assetsRoot = options.assetsRoot ?? ASSETS_ROOT;
    this.renderer = new HbsPromptRenderer({ assetsRoot: this.assetsRoot });
  }

  /** Render a static template by relative path (e.g. `general/system-prompt.md.hbs`). */
  renderStaticTemplate(relativePath: string, context: PromptContext): string {
    return this.renderer.render(relativePath, mapPromptContextToHbs(context));
  }

  /**
   * Build the static half of the system prompt as a single string. The
   * caller (`PromptSystem`) is expected to insert the dynamic boundary
   * token between this string and the dynamic sections.
   *
   * Returns `null` when the rendered template is empty (matches the
   * `PromptSection` contract that returns `null` for omitted content).
   */
  buildStaticSections(
    relativePath: string,
    context: PromptContext,
  ): string | null {
    const rendered = this.renderStaticTemplate(relativePath, context).trim();
    return rendered === '' ? null : rendered;
  }

  /** Compose the full system prompt with a dynamic half joined via the boundary token. */
  buildSystemPrompt(
    relativePath: string,
    context: PromptContext,
    dynamicSections: string[],
  ): SystemPrompt {
    const staticPart = this.buildStaticSections(relativePath, context);
    if (staticPart === null) {
      return asSystemPrompt([...dynamicSections]);
    }
    return asSystemPrompt([
      staticPart,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamicSections,
    ]);
  }

  /** Invalidate the renderer's compile cache (e.g. after a template hot-reload). */
  invalidate(): void {
    this.renderer.invalidate();
  }

  /** Diagnostics. */
  cacheHits(): number {
    return this.renderer.cacheHits();
  }

  cacheMisses(): number {
    return this.renderer.cacheMisses();
  }

  /** Resolve the bound assets root. */
  getAssetsRoot(): string {
    return this.assetsRoot;
  }
}