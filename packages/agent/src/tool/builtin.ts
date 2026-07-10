/**
 * Built-in tools registry
 * Quick initialization with all built-in tools
 */

import { ToolRegistry } from './registry.js';
import type { ToolUseContext } from '../types.js';

// Import all tools
import { BashTool } from './BashTool/BashTool.js';
import { PowerShellTool } from './PowerShellTool/PowerShellTool.js';
import { ReadTool, createReadTool, readFileContent } from './ReadTool/ReadTool.js';
import { WriteTool } from './WriteTool/WriteTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
import { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
import { subagentTool } from './SubagentTool/index.js';
import { teamCreateTool } from './TeamCreateTool/TeamCreateTool.js';
import { teamDeleteTool } from './TeamDeleteTool/TeamDeleteTool.js';

// Phase 5 tools imports
import { taskTool } from './TaskTool/TaskTool.js';
import { enterWorktreeTool } from './EnterWorktreeTool/EnterWorktreeTool.js';
import { exitWorktreeTool } from './ExitWorktreeTool/ExitWorktreeTool.js';
import { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
import { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
import { switchModeTool } from './SwitchModeTool/SwitchModeTool.js';
import { listMcpResourcesTool, setMcpManagerProvider } from './ListMcpResourcesTool/ListMcpResourcesTool.js';
import { readMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js';
import { webSearchTool } from './WebSearchTool/WebSearchTool.js';
import { webFetchTool } from './WebFetchTool/WebFetchTool.js';
import { browserTool } from './BrowserTool/BrowserTool.js';
import type { DomainBlockerConfig } from './BrowserTool/DomainBlocker.js';
import type { BrowserBackendMode } from './BrowserTool/backend-resolver.js';
import { skillTool } from './SkillTool/SkillTool.js';
import { skillManageTool } from './SkillManageTool.js';
import { briefTool } from './BriefTool/BriefTool.js';
import { sessionSearchTool } from './SessionSearchTool/index.js';
import { messageSessionTool } from './MessageSessionTool/index.js';
import { VisionTool } from './VisionTool/VisionTool.js';
import { getMemoryTool } from '../memory/index.js';
import { duyaCliTool } from './DuyaCliTool/index.js';
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js';
// Conductor canvas tools are owned by `@duya/conductor`. The agent
// process loads that ESM package once at async startup and injects the
// tool provider here so `createBuiltinRegistry` can stay synchronous in
// per-turn hot paths.
import { moduleTool } from './ModuleTool/ModuleTool.js';
import { runVisualSelfReview } from './WidgetRenderer/runVisualSelfReview.js';
import { wikiSearchTool, wikiReadTool } from './wiki/index.js';
import { registerBundledAgentPlugins } from '../plugins/BundledPluginRegistry.js';
import { ResearchMemory } from '../research-memory/index.js';
import { hasShellFamily } from '../utils/shellDetector.js';

type ConductorToolProvider = {
  CANVAS_ORCHESTRATOR_TOOLS: import('../types.js').Tool[];
  getCanvasOrchestratorExecutors: () => Record<
    string,
    import('./registry.js').ToolExecutor
  >;
};

let conductorToolProvider: ConductorToolProvider | null = null;

export function setConductorToolProvider(provider: ConductorToolProvider | null): void {
  conductorToolProvider = provider;
}

/**
 * BashTool instance
 */
const bashTool = new BashTool();
const powerShellTool = new PowerShellTool();

/**
 * WriteTool instance
 */
const writeTool = new WriteTool();

/**
 * GrepTool instance
 */
const grepTool = new GrepTool();

/**
 * Create registry with all built-in tools
 */
export function createBuiltinRegistry(
  domainBlockerConfig?: DomainBlockerConfig,
  options?: {
    enabledPluginIds?: Set<string>;
    wikiAgentEnabled?: boolean;
    // Optional accessor that returns the live MCPManager. Wired into
    // ListMcpResourcesTool so it can list real resources from connected
    // servers (the previous version was a stub that always returned
    // "no resources"). Pass a closure that returns the current manager
    // (not the manager itself) so the tool always sees the latest
    // connection state without re-registration.
    mcpManagerProvider?: () => import('../mcp/index.js').MCPManager | undefined;
    // Browser backend mode: 'auto' (degradation chain) | 'extension' | 'built-in'
    browserBackendMode?: BrowserBackendMode;
    /**
     * @deprecated Plan 224 Phase 3: canvas tools are now injected by
     * `conductorMode.tools.inject` via `applyModes` in `DuyaAgent.streamChat`.
     * This flag is no longer read by `createBuiltinRegistry` and is kept
     * only to avoid breaking callers that still pass it. Remove in a
     * future cleanup phase.
     */
    conductorMode?: boolean;
  }
): ToolRegistry {
  const registry = new ToolRegistry();

  if (domainBlockerConfig) {
    browserTool.setDomainBlockerConfig(domainBlockerConfig);
  }

  if (options?.browserBackendMode) {
    browserTool.setBrowserConfig({
      mode: options.browserBackendMode,
      extensionProbeTimeoutMs: 500,
    });
  }

  // Wire the MCP resources tool to the live manager. If no provider was
  // passed (e.g. tests, ad-hoc CLI), the tool falls back to a snapshot
  // pushed via setMcpResources() — same behavior as before, just explicit.
  if (options?.mcpManagerProvider) {
    setMcpManagerProvider(options.mcpManagerProvider);
  }

  // Bash tool - class implements both Tool and ToolExecutor
  registry.register(bashTool.toTool(), bashTool);
  if (hasShellFamily('powershell')) {
    registry.register(powerShellTool.toTool(), powerShellTool);
  }

  // Read tool
  const readTool = new ReadTool();
  registry.register(readTool.toTool(), readTool);

  // Write tool - class implements both Tool and ToolExecutor
  registry.register(writeTool.toTool(), writeTool);

  // Grep tool
  registry.register(grepTool.toTool(), grepTool);

  // Edit tool
  const editToolInstance = new EditTool();
  registry.register(editToolInstance.toTool(), editToolInstance);

  // Glob tool
  const globToolInstance = new GlobTool();
  registry.register(globToolInstance.toTool(), globToolInstance);

  // SubagentTool - for spawning sub-agents
  registry.register(subagentTool.toTool(), subagentTool);

  // Team tools - for multi-agent team coordination
  registry.register(teamCreateTool, teamCreateTool);
  registry.register(teamDeleteTool, teamDeleteTool);

  // Phase 5: Task tool (unified)
  registry.register(taskTool.toTool(), taskTool);

  // Phase 5: Worktree tools
  registry.register(enterWorktreeTool, enterWorktreeTool);
  registry.register(exitWorktreeTool, exitWorktreeTool);

  // Phase 5: Plan mode tools
  registry.register(enterPlanModeTool, enterPlanModeTool);
  registry.register(exitPlanModeTool, exitPlanModeTool);
  registry.register(switchModeTool, switchModeTool);

  // Phase 5: MCP resource tools
  registry.register(listMcpResourcesTool, listMcpResourcesTool);
  registry.register(readMcpResourceTool, readMcpResourceTool);

  // Phase 5: Web tools
  // Note: webSearchTool and webFetchTool are disabled (placeholders for future redesign)
  // registry.register(webSearchTool, webSearchTool);
  // registry.register(webFetchTool, webFetchTool);
  registry.register(browserTool.toTool(), browserTool);

  // Phase 5: Other tools
  registry.register(skillTool, skillTool);
  registry.register(briefTool, briefTool);
  registry.register(sessionSearchTool.toTool(), sessionSearchTool);
  // Inter-agent communication tool — message another session's agent
  registry.register(messageSessionTool.toTool(), messageSessionTool);
  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool);
  // cronTool removed in plan 99 — use `duya_cli` (command: 'cron') instead.
  // See `docs/exec-plans/active/99-duya-cli-argv-and-deprecate-cron-tool.md`.

  // Self-management tools
  //
  // `duya_cli` is the agent's single entry point to the CLI control
  // plane. It runs the same `run*` functions the external `duya`
  // CLI bundle runs, in-process. The legacy `duya_info`,
  // `duya_health`, AND `duya_config` tools were removed in
  // Plan 102 — their capabilities (provider add/remove/activate,
  // mcp add/remove/assign, settings, vision, output style,
  // pairing, plus the legacy read actions) are all reachable
  // through `duya_cli { argv: ["config", …] }` /
  // `duya_cli { argv: ["mcp", …] }`.
  registry.register(duyaCliTool.toTool(), duyaCliTool);

  // Memory tool
  const memoryTool = getMemoryTool();
  registry.register(memoryTool.toTool(), memoryTool);

  // AskUserQuestion tool - prompt the user with multi-choice questions
  registry.register(askUserQuestionTool.toTool(), askUserQuestionTool);

  // ModuleTool - load design specification modules on demand
  // Agent calls read_module BEFORE show_widget or canvas tools to get style guides
  registry.register(moduleTool.toTool(), moduleTool);

  // Skill management tool - for creating/updating skills
  registry.register(skillManageTool, skillManageTool);

  // Wiki tools - for searching and reading wiki knowledge base
  // Only register if wiki agent experimental mode is enabled
  if (options?.wikiAgentEnabled) {
    registry.register(wikiSearchTool.toTool(), wikiSearchTool);
    registry.register(wikiReadTool.toTool(), wikiReadTool);
  }

  // Bundled plugins - register plugin-owned tools via a single pluggable entrypoint
  registerBundledAgentPlugins(registry, options);

  // Research memory tools are a profile subsystem (not plugin-owned assets)
  const researchMemory = new ResearchMemory();
  for (const tool of researchMemory.tools) {
    registry.register(tool.toTool(), tool);
  }

  // show_widget tool - pass-through for generative UI widgets
  registry.register(
    {
      name: 'show_widget',
      description: `Create interactive visualizations, diagrams, charts, calculators, and mini-apps directly in the chat message.

## When to use (two-layer judgment)

Layer 1 — Intent Recognition: use when user asks for visual content ("draw", "visualize", "chart", "diagram", "calculator", "show me").

Layer 2 — Proactive Triggering: use when explaining hierarchical structures, sequential flows, comparisons, step-by-step processes, or any concept where a diagram is clearer than text.

When in doubt, choose the diagram over text.

## Before calling show_widget for the first time

Call \`read_module\` to load the design specification for your rendering approach:
- **diagram** — SVG flowcharts, architecture, structure diagrams
- **mockup** — HTML cards, dashboards, comparison tables, data displays
- **chart** — Chart.js / D3 data visualizations
- **interactive** — Interactive calculators, mini-apps, explainers

You can load multiple: \`["mockup", "chart"]\` for a dashboard with charts. This is YOUR decision — no hook triggers it automatically.

## Guidelines

- Use CDN-whitelisted libraries only: Chart.js, D3.js (SVG mode), ApexCharts, or ECharts
- Include required scripts from CDN (e.g., https://cdn.jsdelivr.net/npm/chart.js)
- Use dark-friendly colors where possible (#4f8cff for primary, #ff6b6b for errors)
- Keep widgets self-contained - embed all data and styling inline
- Specify fixed dimensions (e.g., width=600, height=400) for reliability
- Avoid external API calls from widgets to prevent network errors
- **Embedding images**: To include any image file (chart output, screenshot, photo, etc.) in a widget, you MUST use the custom protocol with an absolute path: <img src="duya-file:///ABSOLUTE_PATH">. Use forward slashes in the path. Examples:
  - Windows: <img src="duya-file:///C:/Users/name/output.png">
  - macOS/Linux: <img src="duya-file:////Users/name/output.png">
  - NEVER use relative paths (e.g., src="Attachments/image.png") — they will not render
  - The platform provides a click-to-preview lightbox for all embedded images`,
      input_schema: {
        type: 'object',
        properties: {
          widget_code: {
            type: 'string',
            description: 'Raw HTML/SVG/JS content. For SVG diagrams, use injected CSS classes as defined in the design modules (loaded via read_module). Output order: <style> → content HTML → <script>. When including images, use duya-file:/// protocol with absolute paths.',
          },
        },
        required: ['widget_code'],
      },
    },
    {
      execute: async (input: Record<string, unknown>, _wd?: string, context?: ToolUseContext) => {
        const widgetCode = input.widget_code as string;

        // Sync pass-through — immediately return widget_code so the existing
        // stream → vizSpec → MessageItem pipeline renders unchanged.
        // The visual self-review is fired as a pendingExtraResult and yields
        // a second tool_result after the headless render + vision call.
        const reviewPromise = runVisualSelfReview(widgetCode ?? '', context);

        // Catch any error inside the deferred pipeline so the executor never
        // sees an unhandled rejection. The agent gets a soft-degrade message
        // instead of the tool_use hanging on a hung promise.
        const safePromise = reviewPromise.then(
          (text) => ({ result: text, is_error: false }),
          (err: unknown) => ({
            result: `Visual self-review failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          }),
        );

        return {
          id: crypto.randomUUID(),
          name: 'show_widget',
          result: JSON.stringify({ widget_code: widgetCode }),
          pendingExtraResult: safePromise,
        };
      },
    }
  );

  // Plan 224 Phase 3: canvas conductor tools are no longer registered
  // here. They are injected declaratively via `conductorMode.tools.inject`
  // when `applyModes` resolves the conductor modifier in `DuyaAgent.streamChat`.
  // The `conductorMode` option is now read from `ChatOptions` by the mode
  // registry, not by `createBuiltinRegistry`.

  return registry;
}

// Export tool definitions for advanced users
export { ToolRegistry } from './registry.js';
export { BashTool } from './BashTool/BashTool.js';
export { PowerShellTool } from './PowerShellTool/PowerShellTool.js';
export { ReadTool, createReadTool, readFileContent } from './ReadTool/ReadTool.js';
export { WriteTool } from './WriteTool/WriteTool.js';
export { GrepTool } from './GrepTool/GrepTool.js';
export { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
export { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
export { getSubagentToolDefinition, getAgentDefinitions, getPrompt } from './SubagentTool/index.js';
export type { AgentDefinition, SubagentToolInput, SubagentToolResult } from './SubagentTool/index.js';
export { teamCreateTool } from './TeamCreateTool/TeamCreateTool.js';
export { teamDeleteTool } from './TeamDeleteTool/TeamDeleteTool.js';

// Phase 5 tools exports
export { taskTool } from './TaskTool/TaskTool.js';
export { enterWorktreeTool } from './EnterWorktreeTool/EnterWorktreeTool.js';
export { exitWorktreeTool } from './ExitWorktreeTool/ExitWorktreeTool.js';
export { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
export { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
export { switchModeTool } from './SwitchModeTool/SwitchModeTool.js';
export { listMcpResourcesTool } from './ListMcpResourcesTool/ListMcpResourcesTool.js';
export { readMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js';
export { webSearchTool } from './WebSearchTool/WebSearchTool.js';
export { webFetchTool } from './WebFetchTool/WebFetchTool.js';
export { browserTool } from './BrowserTool/BrowserTool.js';
export { skillTool } from './SkillTool/SkillTool.js';
export { skillManageTool } from './SkillManageTool.js';
export { briefTool } from './BriefTool/BriefTool.js';
export { VisionTool } from './VisionTool/VisionTool.js';
export { messageSessionTool, MessageSessionTool } from './MessageSessionTool/index.js';
// cronTool removed in plan 99 — use `duya_cli` (command: 'cron') instead.
// duyaConfigTool removed in plan 102 — use `duya_cli` (argv: 'config …' / 'mcp …') instead.
export { duyaCliTool } from './DuyaCliTool/index.js';

// Wiki tools exports
export { wikiSearchTool, wikiReadTool, WikiSearchTool, WikiReadTool } from './wiki/index.js';
