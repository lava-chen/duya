/**
 * Bot-specific tool registry (Plan 241).
 *
 * Independent registry for bots — completely separate from the general agent
 * builtin.ts. This allows per-agent-type exposeMode assignments.
 *
 * Tool strategy:
 * - Bot is a collaborator/assistant, not a primary controller
 * - SubagentTool is hidden (bots should not spawn sub-agents)
 * - BOT_TOOLSET tools are surfaced as 'always' so bots can use them turn one
 * - File search tools (GrepTool, GlobTool) are discoverable (bots use sessionTool instead)
 *
 * Usage:
 *   import { registerBotTools } from './bot-builtin.js';
 *   const registry = new ToolRegistry();
 *   registerBotTools(registry);
 *   const snapshot = registry.snapshot();
 */

import { ToolRegistry } from './registry.js';
import type { ToolUseContext } from '../types.js';

// ============================================================================
// Tool imports
// ============================================================================

import { BashTool } from './BashTool/BashTool.js';
import { ReadTool, createReadTool, readFileContent } from './ReadTool/ReadTool.js';
import { WriteTool } from './WriteTool/WriteTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
import { ApplyPatchTool, applyPatchTool } from './ApplyPatchTool/ApplyPatchTool.js';
import { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
import { subagentTool } from './SubagentTool/index.js';

import { todoTool } from './TodoTool/TodoTool.js';
import { getTaskOutputTool } from './BackgroundTaskTool/index.js';
import { killTaskTool } from './BackgroundTaskTool/index.js';
import { browserTool } from './BrowserTool/BrowserTool.js';
import type { DomainBlockerConfig } from './BrowserTool/DomainBlocker.js';
import type { BrowserBackendMode } from './BrowserTool/backend-resolver.js';
import { skillTool } from './SkillTool/SkillTool.js';
import { briefTool } from './BriefTool/BriefTool.js';
import { sessionSearchTool } from './SessionSearchTool/index.js';
import { messageSessionTool } from './MessageSessionTool/index.js';
import { sessionTool } from './SessionTool/index.js';
import { VisionTool } from './VisionTool/VisionTool.js';
import { imageGenerateTool } from './ImageGenerateTool/index.js';
import { duyaCliTool } from './DuyaCliTool/index.js';
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js';
import { moduleTool } from './ModuleTool/ModuleTool.js';
import { widgetTool } from './WidgetTool/index.js';
import { toolSearchTool } from './ToolSearchTool/ToolSearchTool.js';
import { toolSchemaTool } from './ToolSchemaTool/ToolSchemaTool.js';
import { toolInvokeTool } from './ToolInvokeTool/ToolInvokeTool.js';
import { updateStateTool } from './UpdateStateTool/UpdateStateTool.js';
import { sendMessageTool } from './SendMessageTool/index.js';
import { sendToAgentTool } from './SendToAgentTool/index.js';
import { postToRoomTool } from './PostToRoomTool/index.js';
import { reactToMessageTool } from './ReactToMessageTool/index.js';
import {
  createAgentTool,
  updateAgentTool,
} from './AgentManagementTool/index.js';
import { manageRoutineTool } from './ManageRoutineTool/index.js';
import { listAppConnectorsTool, connectAppTool } from './AppConnectorManageTool/index.js';
import { planTool } from './PlanTool/index.js';

// ============================================================================
// Registry factory
// ============================================================================

export function createBotRegistry(
  domainBlockerConfig?: DomainBlockerConfig,
  options?: {
    enabledPluginIds?: Set<string>;
    browserBackendMode?: BrowserBackendMode;
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

  registerBotTools(registry);

  return registry;
}

// ============================================================================
// Registration entry point
// ============================================================================

export function registerBotTools(registry: ToolRegistry): void {
  // --------------------------------------------------------------------------
  // always — tools with full schema sent every request
  // --------------------------------------------------------------------------

  // Core file operations (excluding GrepTool, GlobTool — see discoverable)
  const bashTool = new BashTool();
  registry.register(bashTool.toTool(), bashTool, { exposeMode: 'always' });

  const readTool = new ReadTool();
  registry.register(readTool.toTool(), readTool, { exposeMode: 'always' });

  const writeTool = new WriteTool();
  registry.register(writeTool.toTool(), writeTool, { exposeMode: 'always' });

  const editToolInstance = new EditTool();
  registry.register(editToolInstance.toTool(), editToolInstance, { exposeMode: 'always' });

  // Todo tool
  registry.register(todoTool.toTool(), todoTool, { exposeMode: 'always' });

  // Background task tools (get_task_output, kill_task — subagent action wrappers)
  registry.register(getTaskOutputTool.toTool(), getTaskOutputTool, { exposeMode: 'always', riskTier: 'read' });
  registry.register(killTaskTool.toTool(), killTaskTool, { exposeMode: 'always', riskTier: 'write' });

  // Tool discovery and invocation infrastructure
  registry.register(toolSearchTool.toTool(), toolSearchTool, { exposeMode: 'always' });
  registry.register(toolSchemaTool.toTool(), toolSchemaTool, { exposeMode: 'always' });
  registry.register(toolInvokeTool.toTool(), toolInvokeTool, { exposeMode: 'always' });

  // BOT_TOOLSET — always for bots (exact-name promotion, turn one available)
  registry.register(sendToAgentTool.toTool(), sendToAgentTool, { exposeMode: 'always' });         // Plan 477
  registry.register(sendMessageTool.toTool(), sendMessageTool, { exposeMode: 'always' });         // Plan 483
  registry.register(createAgentTool.toTool(), createAgentTool, { exposeMode: 'always' });         // Plan 492
  registry.register(updateAgentTool.toTool(), updateAgentTool, { exposeMode: 'always' });         // Plan 492
  registry.register(manageRoutineTool.toTool(), manageRoutineTool, { exposeMode: 'always' });     // Plan 476
  registry.register(postToRoomTool.toTool(), postToRoomTool, { exposeMode: 'always' });           // Plan 478
  registry.register(listAppConnectorsTool.toTool(), listAppConnectorsTool, { exposeMode: 'always' }); // Plan 503
  registry.register(connectAppTool.toTool(), connectAppTool, { exposeMode: 'always' });           // Plan 503
  registry.register(sessionTool.toTool(), sessionTool, { exposeMode: 'always' });                 // Plan 504

  // --------------------------------------------------------------------------
  // hint — stub only (name + desc + arg summary), full schema on demand
  // --------------------------------------------------------------------------

  registry.register(browserTool.toTool(), browserTool, { exposeMode: 'hint' });
  registry.register(skillTool, skillTool, { exposeMode: 'hint' });

  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool, { exposeMode: 'hint' });

  registry.register(imageGenerateTool.toTool(), imageGenerateTool, {
    exposeMode: 'hint',
    inputSchemaSummary: 'prompt (required), size, quality, reference_image, output_path',
  });

  // Plan 525 Phase 4: Unified plan tool for duya project plan management (built-in, replaced MCP)
  registry.register(planTool.toTool(), planTool, { exposeMode: 'hint' });

  // --------------------------------------------------------------------------
  // discoverable — not in tool list, found only via tool_search
  // --------------------------------------------------------------------------

  // File search tools — bots use sessionTool for tasks, not grep/glob directly
  const grepToolInstance = new GrepTool();
  registry.register(grepToolInstance.toTool(), grepToolInstance, { exposeMode: 'discoverable' });
  registry.register(globTool.toTool(), globTool, { exposeMode: 'discoverable' });

  // Communication and search helpers
  registry.register(briefTool, briefTool, { exposeMode: 'discoverable' });
  registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposeMode: 'discoverable' });
  registry.register(messageSessionTool.toTool(), messageSessionTool, { exposeMode: 'discoverable' });

  // update_state — bot memory/state writes (Plan 481)
  registry.register(updateStateTool.toTool(), updateStateTool, { exposeMode: 'discoverable' });

  // duya_cli control plane
  registry.register(duyaCliTool.toTool(), duyaCliTool, { exposeMode: 'discoverable' });

  // ReactToMessage — emoji tapback (Plan 490)
  registry.register(reactToMessageTool.toTool(), reactToMessageTool, { exposeMode: 'discoverable' });

  // ModuleTool — load design specs (for widget authoring guide)
  registry.register(moduleTool.toTool(), moduleTool, { exposeMode: 'discoverable' });

  // --------------------------------------------------------------------------
  // hidden — never exposed to the LLM
  // --------------------------------------------------------------------------

  // SubagentTool — bots should NOT spawn sub-agents (this is the main controller's job)
  registry.register(subagentTool.toTool(), subagentTool, { exposeMode: 'hidden' });

  // AskUserQuestionTool — bots should not directly ask users multi-choice questions
  // (use SendMessage instead)
  registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposeMode: 'hidden' });

  // ApplyPatchTool — Codex diff patch is too low-level for bot use
  registry.register(applyPatchTool.toTool(), applyPatchTool, { exposeMode: 'hidden' });

  // show_widget — bots should not generate UI components
  registry.register(widgetTool.toTool(), widgetTool, { exposeMode: 'hidden' });
}
