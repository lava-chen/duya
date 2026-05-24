/**
 * Built-in tools registry
 * Quick initialization with all built-in tools
 */

import { ToolRegistry } from './registry.js';

// Import all tools
import { BashTool } from './BashTool/BashTool.js';
import { ReadTool, createReadTool, readFileContent } from './ReadTool/ReadTool.js';
import { WriteTool } from './WriteTool/WriteTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
import { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
import { agentTool } from './AgentTool/index.js';
import { teamCreateTool } from './TeamCreateTool/TeamCreateTool.js';
import { teamDeleteTool } from './TeamDeleteTool/TeamDeleteTool.js';

// Phase 5 tools imports
import { taskTool } from './TaskTool/TaskTool.js';
import { enterWorktreeTool } from './EnterWorktreeTool/EnterWorktreeTool.js';
import { exitWorktreeTool } from './ExitWorktreeTool/ExitWorktreeTool.js';
import { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
import { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
import { switchModeTool } from './SwitchModeTool/SwitchModeTool.js';
import { listMcpResourcesTool } from './ListMcpResourcesTool/ListMcpResourcesTool.js';
import { readMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js';
import { webSearchTool } from './WebSearchTool/WebSearchTool.js';
import { webFetchTool } from './WebFetchTool/WebFetchTool.js';
import { browserTool } from './BrowserTool/BrowserTool.js';
import type { DomainBlockerConfig } from './BrowserTool/DomainBlocker.js';
import { skillTool } from './SkillTool/SkillTool.js';
import { skillManageTool } from './SkillManageTool.js';
import { briefTool } from './BriefTool/BriefTool.js';
import { sessionSearchTool } from './SessionSearchTool/index.js';
import { VisionTool } from './VisionTool/VisionTool.js';
import { getMemoryTool } from '../memory/index.js';
import { cronTool } from './CronTool/index.js';
import { CANVAS_ORCHESTRATOR_TOOLS, getCanvasOrchestratorExecutors } from '../conductor/CanvasOrchestratorProfile.js';
import { duyaInfoTool } from './DuyaInfoTool/index.js';
import { duyaConfigTool } from './DuyaConfigTool/index.js';
import { duyaHealthTool } from './DuyaHealthTool/index.js';
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js';
import { moduleTool } from './ModuleTool/ModuleTool.js';

/**
 * BashTool instance
 */
const bashTool = new BashTool();

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
export function createBuiltinRegistry(domainBlockerConfig?: DomainBlockerConfig): ToolRegistry {
  const registry = new ToolRegistry();

  if (domainBlockerConfig) {
    browserTool.setDomainBlockerConfig(domainBlockerConfig);
  }

  // Bash tool - class implements both Tool and ToolExecutor
  registry.register(bashTool.toTool(), bashTool);

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

  // AgentTool - for spawning sub-agents
  registry.register(agentTool.toTool(), agentTool);

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
  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool);
  registry.register(cronTool.toTool(), cronTool);

  // Self-management tools
  registry.register(duyaInfoTool.toTool(), duyaInfoTool);
  registry.register(duyaConfigTool.toTool(), duyaConfigTool);
  registry.register(duyaHealthTool.toTool(), duyaHealthTool);

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
- Avoid external API calls from widgets to prevent network errors`,
      input_schema: {
        type: 'object',
        properties: {
          widget_code: {
            type: 'string',
            description: 'Raw HTML/SVG/JS content. For SVG diagrams, use injected CSS classes as defined in the design modules (loaded via read_module). Output order: <style> → content HTML → <script>.',
          },
        },
        required: ['widget_code'],
      },
    },
    {
      execute: async (input: Record<string, unknown>) => {
        return {
          id: crypto.randomUUID(),
          name: 'show_widget',
          result: JSON.stringify({ widget_code: input.widget_code }),
        };
      },
    }
  );

  // Canvas Orchestrator tools - generic element operations
  const orchestratorExecutors = getCanvasOrchestratorExecutors();
  for (const tool of CANVAS_ORCHESTRATOR_TOOLS) {
    const executor = orchestratorExecutors[tool.name];
    if (executor) {
      registry.register(tool, executor);
    }
  }

  return registry;
}

// Export tool definitions for advanced users
export { ToolRegistry } from './registry.js';
export { BashTool } from './BashTool/BashTool.js';
export { ReadTool, createReadTool, readFileContent } from './ReadTool/ReadTool.js';
export { WriteTool } from './WriteTool/WriteTool.js';
export { GrepTool } from './GrepTool/GrepTool.js';
export { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
export { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
export { getAgentToolDefinition, getAgentDefinitions, getPrompt } from './AgentTool/index.js';
export type { AgentDefinition, AgentToolInput, AgentToolResult } from './AgentTool/index.js';
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
export { cronTool } from './CronTool/index.js';
export { duyaInfoTool } from './DuyaInfoTool/index.js';
export { duyaConfigTool } from './DuyaConfigTool/index.js';
export { duyaHealthTool } from './DuyaHealthTool/index.js';
