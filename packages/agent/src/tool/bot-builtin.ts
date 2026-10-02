/**
 * Bot-specific tool registry (Plan 241).
 *
 * Independent registry for bots — completely separate from the general agent
 * builtin.ts. This allows per-agent-type exposure assignments.
 *
 * Tool strategy:
 * - Bot is a collaborator/assistant, not a primary controller
 * - SubagentTool is hidden (bots should not spawn sub-agents)
 * - BOT_TOOLSET tools are surfaced as 'always' so bots can use them turn one
 * - File search tools (GrepTool, GlobTool) are deferred (bots use sessionTool instead)
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
import { ReadTool, readFileContent } from './ReadTool/ReadTool.js';
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
import { ToolCatalogTool } from './ToolCatalogTool/ToolCatalogTool.js';
import { ToolInvokeTool } from './ToolInvokeTool/ToolInvokeTool.js';
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

  // Core file operations (excluding GrepTool, GlobTool — see deferred tools)
  const bashTool = new BashTool();
  registry.register(bashTool.toTool(), bashTool, { exposure: 'eager' });

  const readTool = new ReadTool();
  registry.register(readTool.toTool(), readTool, { exposure: 'eager' });

  const writeTool = new WriteTool();
  registry.register(writeTool.toTool(), writeTool, { exposure: 'eager' });

  const editToolInstance = new EditTool();
  registry.register(editToolInstance.toTool(), editToolInstance, { exposure: 'eager' });

  // Todo tool
  registry.register(todoTool.toTool(), todoTool, { exposure: 'eager' });

  // Background task tools (get_task_output, kill_task — subagent action wrappers)
  registry.register(getTaskOutputTool.toTool(), getTaskOutputTool, { exposure: 'eager', riskTier: 'read' });
  registry.register(killTaskTool.toTool(), killTaskTool, { exposure: 'eager', riskTier: 'write' });

  const toolCatalogTool = new ToolCatalogTool();
  const toolInvokeTool = new ToolInvokeTool();
  registry.register(toolCatalogTool.toTool(), toolCatalogTool, { exposure: 'eager' });
  registry.register(toolInvokeTool.toTool(), toolInvokeTool, { exposure: 'eager' });

  // BOT_TOOLSET — always for bots (exact-name promotion, turn one available)
  registry.register(sendToAgentTool.toTool(), sendToAgentTool, { exposure: 'eager' });         // Plan 477
  registry.register(sendMessageTool.toTool(), sendMessageTool, { exposure: 'eager' });         // Plan 483
  registry.register(createAgentTool.toTool(), createAgentTool, { exposure: 'eager' });         // Plan 492
  registry.register(updateAgentTool.toTool(), updateAgentTool, { exposure: 'eager' });         // Plan 492
  registry.register(manageRoutineTool.toTool(), manageRoutineTool, { exposure: 'eager' });     // Plan 476
  registry.register(postToRoomTool.toTool(), postToRoomTool, { exposure: 'eager' });           // Plan 478
  registry.register(listAppConnectorsTool.toTool(), listAppConnectorsTool, { exposure: 'eager' }); // Plan 503
  registry.register(connectAppTool.toTool(), connectAppTool, { exposure: 'eager' });           // Plan 503
  registry.register(sessionTool.toTool(), sessionTool, { exposure: 'eager' });                 // Plan 504

  // --------------------------------------------------------------------------
  // Direct tools and deferred tools
  // --------------------------------------------------------------------------

  registry.register(browserTool.toTool(), browserTool, {
    exposure: 'deferred',
    inputSchemaSummary: 'Search, open, inspect, and interact with webpages using a persistent browser session.',
  });
  // Keep Skill on the eager surface so its real input schema is available;
  // the previous hint stub exposed an empty schema and failed validation.
  registry.register(skillTool, skillTool, { exposure: 'eager' });

  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool, { exposure: 'eager' });

  registry.register(imageGenerateTool.toTool(), imageGenerateTool, {
    exposure: 'deferred',
    inputSchemaSummary: 'prompt (required), size, quality, reference_image, output_path',
  });

  // Plan 525 Phase 4: Unified plan tool for duya project plan management (built-in, replaced MCP)
  registry.register(planTool.toTool(), planTool, { exposure: 'eager' });

  // --------------------------------------------------------------------------
  // deferred — not in tool list, found only via tool_catalog
  // --------------------------------------------------------------------------

  // File search tools — bots use sessionTool for tasks, not grep/glob directly
  const grepToolInstance = new GrepTool();
  registry.register(grepToolInstance.toTool(), grepToolInstance, { exposure: 'deferred' });
  registry.register(globTool.toTool(), globTool, { exposure: 'deferred' });

  // Communication and search helpers
  registry.register(briefTool, briefTool, { exposure: 'deferred' });
  registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposure: 'deferred' });
  registry.register(messageSessionTool.toTool(), messageSessionTool, { exposure: 'deferred' });

  // update_state — bot memory/state writes (Plan 481)
  registry.register(updateStateTool.toTool(), updateStateTool, { exposure: 'deferred' });

  // duya_cli control plane
  registry.register(duyaCliTool.toTool(), duyaCliTool, { exposure: 'deferred' });

  // ReactToMessage — emoji tapback (Plan 490)
  registry.register(reactToMessageTool.toTool(), reactToMessageTool, { exposure: 'deferred' });

  // ModuleTool — load design specs (for widget authoring guide)
  registry.register(moduleTool.toTool(), moduleTool, { exposure: 'deferred' });

  // --------------------------------------------------------------------------
  // hidden — never exposed to the LLM
  // --------------------------------------------------------------------------

  // SubagentTool — bots should NOT spawn sub-agents (this is the main controller's job)
  registry.register(subagentTool.toTool(), subagentTool, { exposure: 'hidden' });

  // AskUserQuestionTool — bots should not directly ask users multi-choice questions
  // (use SendMessage instead)
  registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposure: 'hidden' });

  // ApplyPatchTool — Codex diff patch is too low-level for bot use
  registry.register(applyPatchTool.toTool(), applyPatchTool, { exposure: 'hidden' });

  // show_widget — bots should not generate UI components
  registry.register(widgetTool.toTool(), widgetTool, { exposure: 'hidden' });
}
