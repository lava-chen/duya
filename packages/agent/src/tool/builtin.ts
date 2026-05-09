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
import { teamCreateTool } from '../tools/TeamCreateTool/TeamCreateTool.js';
import { teamDeleteTool } from '../tools/TeamDeleteTool/TeamDeleteTool.js';

// Phase 5 tools imports
import { taskCreateTool } from './TaskCreateTool/TaskCreateTool.js';
import { taskGetTool } from './TaskGetTool/TaskGetTool.js';
import { taskListTool } from './TaskListTool/TaskListTool.js';
import { taskOutputTool } from './TaskOutputTool/TaskOutputTool.js';
import { taskStopTool } from './TaskStopTool/TaskStopTool.js';
import { taskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js';
import { enterWorktreeTool } from './EnterWorktreeTool/EnterWorktreeTool.js';
import { exitWorktreeTool } from './ExitWorktreeTool/ExitWorktreeTool.js';
import { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
import { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
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
import { getMemoryTool } from '../memory/index.js';
import { cronTool } from './CronTool/index.js';
import { CONDUCTOR_TOOLS, getConductorToolExecutors } from '../conductor/ConductorProfile.js';
import { CANVAS_ORCHESTRATOR_TOOLS, getCanvasOrchestratorExecutors } from '../conductor/CanvasOrchestratorProfile.js';
import { duyaInfoTool } from './DuyaInfoTool/index.js';
import { duyaConfigTool } from './DuyaConfigTool/index.js';
import { duyaRestartTool } from './DuyaRestartTool/index.js';
import { duyaHealthTool } from './DuyaHealthTool/index.js';
import { duyaSessionsTool } from './DuyaSessionsTool/index.js';
import { duyaLogsTool } from './DuyaLogsTool/index.js';

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

  // Phase 5: Task tools
  registry.register(taskCreateTool, taskCreateTool);
  registry.register(taskGetTool, taskGetTool);
  registry.register(taskListTool, taskListTool);
  registry.register(taskOutputTool, taskOutputTool);
  registry.register(taskStopTool, taskStopTool);
  registry.register(taskUpdateTool, taskUpdateTool);

  // Phase 5: Worktree tools
  registry.register(enterWorktreeTool, enterWorktreeTool);
  registry.register(exitWorktreeTool, exitWorktreeTool);

  // Phase 5: Plan mode tools
  registry.register(enterPlanModeTool, enterPlanModeTool);
  registry.register(exitPlanModeTool, exitPlanModeTool);

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
  registry.register(cronTool.toTool(), cronTool);

  // Self-management tools
  registry.register(duyaInfoTool.toTool(), duyaInfoTool);
  registry.register(duyaConfigTool.toTool(), duyaConfigTool);
  registry.register(duyaRestartTool.toTool(), duyaRestartTool);
  registry.register(duyaHealthTool.toTool(), duyaHealthTool);
  registry.register(duyaSessionsTool.toTool(), duyaSessionsTool);
  registry.register(duyaLogsTool.toTool(), duyaLogsTool);

  // Memory tool
  const memoryTool = getMemoryTool();
  registry.register(memoryTool.toTool(), memoryTool);

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

When in doubt, choose the diagram over text.`,
      input_schema: {
        type: 'object',
        properties: {
          widget_code: {
            type: 'string',
            description: 'Raw HTML/SVG/JS content. Use injected CSS classes: s-plat, s-proc, s-agent, s-msg, s-err, s-chk, s-sub, s-sub-dark (containers); t-dark, t-dim-dark, t-light, t-dim, t-green, t-gray, t-gray-dim, td-on-dark, td-on-dark-dim (text); tt, td (typography); c-bx, n-box (layout); arr-line (arrows). ViewBox: "0 0 680 H". Safe area x∈[30,650]. Outer containers x=30 w=620. Node gap≥16px, pad 16px. Single-line 44px, dual-line 60px.',
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

  // Conductor tools - canvas widget operations
  const conductorExecutors = getConductorToolExecutors();
  for (const tool of CONDUCTOR_TOOLS) {
    const executor = conductorExecutors[tool.name];
    if (executor) {
      registry.register(tool, executor);
    }
  }

  // Canvas Orchestrator V2 tools - generic element operations
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
export { teamCreateTool } from '../tools/TeamCreateTool/TeamCreateTool.js';
export { teamDeleteTool } from '../tools/TeamDeleteTool/TeamDeleteTool.js';

// Phase 5 tools exports
export { taskCreateTool } from './TaskCreateTool/TaskCreateTool.js';
export { taskGetTool } from './TaskGetTool/TaskGetTool.js';
export { taskListTool } from './TaskListTool/TaskListTool.js';
export { taskOutputTool } from './TaskOutputTool/TaskOutputTool.js';
export { taskStopTool } from './TaskStopTool/TaskStopTool.js';
export { taskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js';
export { enterWorktreeTool } from './EnterWorktreeTool/EnterWorktreeTool.js';
export { exitWorktreeTool } from './ExitWorktreeTool/ExitWorktreeTool.js';
export { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
export { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
export { listMcpResourcesTool } from './ListMcpResourcesTool/ListMcpResourcesTool.js';
export { readMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js';
export { webSearchTool } from './WebSearchTool/WebSearchTool.js';
export { webFetchTool } from './WebFetchTool/WebFetchTool.js';
export { browserTool } from './BrowserTool/BrowserTool.js';
export { skillTool } from './SkillTool/SkillTool.js';
export { skillManageTool } from './SkillManageTool.js';
export { briefTool } from './BriefTool/BriefTool.js';
export { cronTool } from './CronTool/index.js';
export { duyaInfoTool } from './DuyaInfoTool/index.js';
export { duyaConfigTool } from './DuyaConfigTool/index.js';
export { duyaRestartTool } from './DuyaRestartTool/index.js';
export { duyaHealthTool } from './DuyaHealthTool/index.js';
export { duyaSessionsTool } from './DuyaSessionsTool/index.js';
export { duyaLogsTool } from './DuyaLogsTool/index.js';
