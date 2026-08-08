/**
 * Built-in tools registry
 * Quick initialization with all built-in tools
 */

import { ToolRegistry } from './registry.js';
import type { ToolMetaInput } from './registry.js';
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

// Phase 5 tools imports
import { taskTool } from './TaskTool/TaskTool.js';
import { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
import { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
import { switchModeTool } from './SwitchModeTool/SwitchModeTool.js';
import { browserTool } from './BrowserTool/BrowserTool.js';
import type { DomainBlockerConfig } from './BrowserTool/DomainBlocker.js';
import type { BrowserBackendMode } from './BrowserTool/backend-resolver.js';
import { skillTool } from './SkillTool/SkillTool.js';
import { briefTool } from './BriefTool/BriefTool.js';
import { sessionSearchTool } from './SessionSearchTool/index.js';
import { messageSessionTool } from './MessageSessionTool/index.js';
import { VisionTool } from './VisionTool/VisionTool.js';
import { duyaCliTool } from './DuyaCliTool/index.js';
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js';
import { moduleTool } from './ModuleTool/ModuleTool.js';
import { runVisualSelfReview } from './WidgetRenderer/runVisualSelfReview.js';
import { hasShellFamily } from '../utils/shellDetector.js';
import { toolSearchTool } from './ToolSearchTool/ToolSearchTool.js';

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

  // Bash is the default shell on every platform. PowerShell remains
  // available via tool_search when present, but is not exposed on the
  // initial tool surface — its quoting/escaping quirks caused too many
  // execution bugs. On Windows without Git Bash, the bash tool still
  // works because resolveShellExecutionPlan falls back to PowerShell.
  registry.register(bashTool.toTool(), bashTool, {
    exposeMode: 'always',
  });
  if (hasShellFamily('powershell')) {
    registry.register(powerShellTool.toTool(), powerShellTool, {
      exposeMode: 'discoverable',
    });
  }

  // Read tool
  const readTool = new ReadTool();
  registry.register(readTool.toTool(), readTool, { exposeMode: 'always' });

  // Write tool - class implements both Tool and ToolExecutor
  registry.register(writeTool.toTool(), writeTool, { exposeMode: 'always' });

  // Grep tool
  registry.register(grepTool.toTool(), grepTool, { exposeMode: 'always' });

  // Edit tool
  const editToolInstance = new EditTool();
  registry.register(editToolInstance.toTool(), editToolInstance, { exposeMode: 'always' });

  // Glob tool
  const globToolInstance = new GlobTool();
  registry.register(globToolInstance.toTool(), globToolInstance, { exposeMode: 'always' });

  // SubagentTool - for spawning sub-agents
  registry.register(subagentTool.toTool(), subagentTool, { exposeMode: 'always' });

  // Phase 5: Task tool (unified)
  registry.register(taskTool.toTool(), taskTool, { exposeMode: 'always' });

  // Plan mode controls are available through tool_search when needed.
  registry.register(enterPlanModeTool, enterPlanModeTool, { exposeMode: 'discoverable' });
  registry.register(exitPlanModeTool, exitPlanModeTool, { exposeMode: 'discoverable' });
  registry.register(switchModeTool, switchModeTool, { exposeMode: 'discoverable' });

  // Browser is the supported web search and fetch surface. Exposed on the
  // initial tool surface so the model can reach web content without first
  // having to discover the tool via `tool_search`.
  registry.register(browserTool.toTool(), browserTool, { exposeMode: 'always' });

  // Phase 5: Other tools
  // The Skills catalog instructs the model to call Skill. It must therefore
  // be present on the initial tool surface, not merely discoverable.
  registry.register(skillTool, skillTool, { exposeMode: 'always' });
  registry.register(briefTool, briefTool, { exposeMode: 'discoverable' });
  registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposeMode: 'discoverable' });
  // Inter-agent communication tool — message another session's agent
  registry.register(messageSessionTool.toTool(), messageSessionTool, { exposeMode: 'discoverable' });
  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool, { exposeMode: 'discoverable' });
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
  registry.register(duyaCliTool.toTool(), duyaCliTool, { exposeMode: 'discoverable' });

  // AskUserQuestion tool - prompt the user with multi-choice questions
  registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposeMode: 'discoverable' });

  // ModuleTool - load design specification modules on demand
  // Agent calls read_module BEFORE show_widget or canvas tools to get style guides
  registry.register(moduleTool.toTool(), moduleTool, { exposeMode: 'discoverable' });

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
- **Embedding images**: Widget images must use \`https:\` or \`data:\` URLs only. The widget iframe's Content-Security-Policy blocks local file paths (\`file://\`, bare relative paths). To embed a generated image, encode it as a data URL or host it temporarily on a CDN the widget allowlist permits. Clicking an embedded image opens DUYA's lightbox.`,
      input_schema: {
        type: 'object',
        properties: {
          widget_code: {
            type: 'string',
            description: 'Raw HTML/SVG/JS content. For SVG diagrams, use injected CSS classes as defined in the design modules (loaded via read_module). Output order: <style> → content HTML → <script>. For images, use https: or data: URLs only — local file paths are blocked by the widget CSP.',
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
    },
    { exposeMode: 'discoverable' }
  );

  // Plan 224 Phase 3: canvas conductor tools are no longer registered
  // here. They are injected declaratively via `conductorMode.tools.inject`
  // when `applyModes` resolves the conductor modifier in `DuyaAgent.streamChat`.
  // The `conductorMode` option is now read from `ChatOptions` by the mode
  // registry, not by `createBuiltinRegistry`.

  // Plan 241 Phase 1: ToolSearchTool must be in the registry so the LLM
  // can call it. It's always exposed (Phase 1 does not yet filter by
  // exposeMode). The actual `setSearchFn` injection lives in
  // `DuyaAgent.streamChat` because it needs access to the per-call
  // registry (including MCP-injected tools).
  registry.register(toolSearchTool.toTool(), toolSearchTool, { exposeMode: 'always' });

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

// Phase 5 tools exports
export { taskTool } from './TaskTool/TaskTool.js';
export { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
export { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
export { switchModeTool } from './SwitchModeTool/SwitchModeTool.js';
export { browserTool } from './BrowserTool/BrowserTool.js';
export { skillTool } from './SkillTool/SkillTool.js';
export { briefTool } from './BriefTool/BriefTool.js';
export { VisionTool } from './VisionTool/VisionTool.js';
export { messageSessionTool, MessageSessionTool } from './MessageSessionTool/index.js';
// cronTool removed in plan 99 — use `duya_cli` (command: 'cron') instead.
// duyaConfigTool removed in plan 102 — use `duya_cli` (argv: 'config …' / 'mcp …') instead.
export { duyaCliTool } from './DuyaCliTool/index.js';


