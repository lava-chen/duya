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
import { ReadTool, readFileContent } from './ReadTool/ReadTool.js';
import { WriteTool } from './WriteTool/WriteTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
import { ApplyPatchTool, applyPatchTool } from './ApplyPatchTool/ApplyPatchTool.js';
import { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
import { MemoryWriteTool } from './MemoryWriteTool/MemoryWriteTool.js';
import { WriteStage1PolicyTool } from './WriteStage1PolicyTool/WriteStage1PolicyTool.js';
import { SendArtifactTool } from './SendArtifactTool/SendArtifactTool.js';
import { SubagentTool } from './SubagentTool/index.js';
import type { SubagentRunDeps } from './SubagentTool/index.js';

// Phase 5 tools imports
import { todoTool } from './TodoTool/TodoTool.js';
import { getTaskOutputTool } from './BackgroundTaskTool/index.js';
import { killTaskTool } from './BackgroundTaskTool/index.js';
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
import { sessionTool } from './SessionTool/index.js';
import { VisionTool } from './VisionTool/VisionTool.js';
import { imageGenerateTool } from './ImageGenerateTool/index.js';
import { duyaCliTool } from './DuyaCliTool/index.js';
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js';
import { moduleTool } from './ModuleTool/ModuleTool.js';
import { widgetTool } from './WidgetTool/index.js';
import { hasShellFamily } from '../utils/shellDetector.js';
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
import { getComputerUseToolsWithDecide } from './OSTool/index.js';
import { definition as computerCuaDefinition, executor as computerCuaExecutor } from './OSTool/ComputerCuaTool.js';

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
 *
 * Plan 610 A5: `deps` is required. Each registry constructs its OWN
 * `SubagentTool` instance bound to the factories the caller supplied, so the
 * tool's child-agent wiring is fixed at assembly and validated by the
 * compiler. `createToolRegistry` is deliberately NOT specialised here — it is
 * handed through as given, because a child agent's registry has always been a
 * plain `createBuiltinRegistry()` with no domain-blocker or plugin filtering.
 * Forwarding this registry's own arguments into it would be a behaviour change.
 */
export function createBuiltinRegistry(
  deps: SubagentRunDeps,
  domainBlockerConfig?: DomainBlockerConfig,
  options?: {
    enabledPluginIds?: Set<string>;
    // Browser backend mode: 'auto' (degradation chain) | 'extension' | 'built-in'
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

  // Bash is the default shell on every platform. PowerShell remains
  // available via tool_catalog when present, but is not exposed on the
  // initial tool surface — its quoting/escaping quirks caused too many
  // execution bugs. On Windows without Git Bash, the bash tool still
  // works because resolveShellExecutionPlan falls back to PowerShell.
  registry.register(bashTool.toTool(), bashTool, {
    exposure: 'eager',
  });
  if (hasShellFamily('powershell')) {
    registry.register(powerShellTool.toTool(), powerShellTool, {
      exposure: 'deferred',
    });
  }

  // Read tool
  const readTool = new ReadTool();
  registry.register(readTool.toTool(), readTool, { exposure: 'eager' });

  // Write tool - class implements both Tool and ToolExecutor
  registry.register(writeTool.toTool(), writeTool, { exposure: 'eager' });

  // Grep tool
  registry.register(grepTool.toTool(), grepTool, { exposure: 'eager' });

  // Edit tool
  const editToolInstance = new EditTool();
  registry.register(editToolInstance.toTool(), editToolInstance, { exposure: 'eager' });

  // Apply patch tool - unified diff application (Codex format)
  const applyPatchToolInstance = new ApplyPatchTool();
  registry.register(applyPatchToolInstance.toTool(), applyPatchToolInstance, { exposure: 'eager' });

  // Glob tool
  const globToolInstance = new GlobTool();
  registry.register(globToolInstance.toTool(), globToolInstance, { exposure: 'eager' });

  // SubagentTool - for spawning sub-agents.
  // Plan 610 A5: one instance per registry, not a shared module singleton.
  const subagentTool = new SubagentTool(deps);
  registry.register(subagentTool.toTool(), subagentTool, { exposure: 'eager' });

  // Memory curation tools — validated writes, registered deferred so the
  // curator profile can select them via allowedTools.
  const memoryWriteTool = new MemoryWriteTool();
  registry.register(memoryWriteTool.toTool(), memoryWriteTool, { exposure: 'deferred' });
  const writeStage1PolicyTool = new WriteStage1PolicyTool();
  registry.register(writeStage1PolicyTool.toTool(), writeStage1PolicyTool, { exposure: 'deferred' });

  // Phase 5: Todo tool (aligned to Grok todo_write)
  registry.register(todoTool.toTool(), todoTool, { exposure: 'eager' });

  // Phase 5: Background sub-agent task tools. get_task_output is a read-only
  // status/output snapshot (never blocks — completion arrives as an async
  // <task-notification>); kill_task is a write.
  registry.register(getTaskOutputTool.toTool(), getTaskOutputTool, { exposure: 'eager', riskTier: 'read' });
  registry.register(killTaskTool.toTool(), killTaskTool, { exposure: 'eager', riskTier: 'write' });

  // Plan mode controls are available through tool_catalog when needed.
  registry.register(enterPlanModeTool, enterPlanModeTool, { exposure: 'deferred' });
  registry.register(exitPlanModeTool, exitPlanModeTool, { exposure: 'deferred' });
  registry.register(switchModeTool, switchModeTool, { exposure: 'deferred' });

  // Browser has many operations, so keep its full schema behind the catalog.
  registry.register(browserTool.toTool(), browserTool, {
    exposure: 'deferred',
    inputSchemaSummary: 'Search, open, inspect, and interact with webpages using a persistent browser session.',
  });

  // Phase 5: Other tools
  // Skill must be on the initial surface (Skills catalog instructs model to
  // call it). Keep its real, compact schema on the eager surface; previous
  // hint stubs exposed an empty schema and caused Skill calls to fail validation.
  registry.register(skillTool, skillTool, { exposure: 'eager' });
  registry.register(briefTool, briefTool, { exposure: 'deferred' });
  registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposure: 'deferred' });
  // Inter-agent communication tool — message another session's agent
  registry.register(messageSessionTool.toTool(), messageSessionTool, { exposure: 'deferred' });
  // Plan 504 — spawn a real project-scoped child session and run it async.
  // Bot-exclusive: not auto-surfaced to general sessions (mirrors
  // send_to_agent); bots get exact-name promotion via BOT_TOOLSET.
  registry.register(sessionTool.toTool(), sessionTool, { exposure: 'deferred' });
  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool, { exposure: 'eager' });

  // image_generate — media generation tool (plan image-gen). Registered
  // deferred: it stays off the default tool surface and is reached via
  // `tool_catalog`. Config lives under `[image_generation]` in config.toml.
  registry.register(imageGenerateTool.toTool(), imageGenerateTool, {
    exposure: 'deferred',
    inputSchemaSummary: 'prompt (required), size, quality, reference_image, output_path',
  });
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
  registry.register(duyaCliTool.toTool(), duyaCliTool, { exposure: 'deferred' });

  // AskUserQuestion tool - prompt the user with multi-choice questions
  registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposure: 'eager' });

  // ModuleTool - load design specification modules on demand
  // Agent calls read_module BEFORE show_widget or canvas tools to get style guides
  registry.register(moduleTool.toTool(), moduleTool, { exposure: 'deferred' });

  // show_widget — generative UI widgets (charts, diagrams, calculators, mini-apps).
  // Short description kept inline; see WidgetTool for full executor.
  registry.register(widgetTool.toTool(), widgetTool, {
    exposure: 'deferred',
    inputSchemaSummary: 'Create a chart, diagram, calculator, or small interactive app for the conversation.',
  });

  // send_artifact - explicit outbound file delivery through a gateway channel.
  // Deferred: gateway sessions reach it via tool_catalog; in desktop
  // sessions it is a harmless no-op, so keeping it off the default tool
  // surface saves the schema tokens.
  const sendArtifactTool = new SendArtifactTool();
  registry.register(sendArtifactTool.toTool(), sendArtifactTool, { exposure: 'deferred' });

  // Plan 224 Phase 3: canvas conductor tools are no longer registered
  // here. They are injected declaratively via `conductorMode.tools.inject`
  // when `applyModes` resolves the conductor modifier in `DuyaAgent.streamChat`.
  // The `conductorMode` option is now read from `ChatOptions` by the mode
  // registry, not by `createBuiltinRegistry`.

  const toolCatalogTool = new ToolCatalogTool();
  const toolInvokeTool = new ToolInvokeTool();
  registry.register(toolCatalogTool.toTool(), toolCatalogTool, { exposure: 'eager' });
  registry.register(toolInvokeTool.toTool(), toolInvokeTool, { exposure: 'eager' });

  // Plan 481 T1: update_state — bot memory/state writes through the 479 tier
  // store (see UpdateStateTool). Discoverable: only bot profiles surface it
  // (bot-toolset.ts appends it to allowedTools); checkPermissions maps
  // own=allow / shared=ask per the 481 permission matrix.
  registry.register(updateStateTool.toTool(), updateStateTool, { exposure: 'deferred' });

  // Plan 483 P2: SendMessage — bot proactive message delivery to the UI.
  // Based on grok-bot SendMessage semantics: this is the ONLY way for a bot to
  // communicate with the user. Plain assistant text is invisible.
  // Discoverable: only bot profiles surface it (bot-toolset.ts appends it to
  // allowedTools). The message is saved to DB and pushed to the renderer via
  // SSE broadcast in the message:append handler.
  registry.register(sendMessageTool.toTool(), sendMessageTool, { exposure: 'deferred' });

  // Plan 477 P1.2: send_to_agent — asynchronous agent-to-agent DM. The
  // message lands in the target's agent_mailbox (kind='agent_dm') and the
  // 476 wake bus handles waking the recipient. Discoverable: bot profiles
  // surface it via the BOT_TOOLSET exact-name promotion (plan 496).
  registry.register(sendToAgentTool.toTool(), sendToAgentTool, { exposure: 'deferred' });

  // Plan 478 P2.1: post_to_room — a member's only voice into a shared room
  // (grok group SendMessage parity). The authored entry lands directly in the
  // room transcript session (`room:<roomId>`); the main process hooks the
  // append for room sessions and drives the round-robin orchestrator.
  // Discoverable: surfaced via the BOT_TOOLSET exact-name promotion.
  registry.register(postToRoomTool.toTool(), postToRoomTool, { exposure: 'deferred' });

  // Plan 492 P4: create_agent / update_agent — bot self-management (grok
  // sand-agent-management-tools parity). Persistence goes through the
  // db-bridge config:agents:create|update cases; the main process owns the
  // config.toml write. Discoverable: bot profiles surface them via
  // BOT_TOOLSET; main-session '*' profiles stay behind tool_catalog.
  registry.register(createAgentTool.toTool(), createAgentTool, { exposure: 'deferred' });
  registry.register(updateAgentTool.toTool(), updateAgentTool, { exposure: 'deferred' });

  // Plan 476 P2.3b: manage_routine — bot routine self-management (grok
  // update_state target "routine" parity). Persistence goes through the
  // db-bridge automation:cron:* cases; the tool enforces bot ownership
  // agent-side (bridge has no session context). Discoverable: bot profiles
  // surface it via BOT_TOOLSET; main sessions cannot own routines.
  registry.register(manageRoutineTool.toTool(), manageRoutineTool, { exposure: 'deferred' });

  // Plan 503: list_app_connectors / connect_app — bot-only connector
  // elicitation (grok AuthenticateMcpServer parity). connect_app shows the
  // user a connect card (chat:connector_auth_required variant 'connect')
  // and never touches tokens; the OAuth flow and resume stay in main + UI.
  // Discoverable: bot profiles surface them via BOT_TOOLSET; interactive
  // main-session agents keep the settings-page connect flow.
  registry.register(listAppConnectorsTool.toTool(), listAppConnectorsTool, { exposure: 'deferred' });
  registry.register(connectAppTool.toTool(), connectAppTool, { exposure: 'deferred' });

  // Plan 490 P1: ReactToMessage — emoji tapback on a chat message (grok
  // sand-reaction-tool parity). Deferred: reached via tool_catalog when
  // the model needs it; the schema cost does not justify a permanent slot
  // on the default surface. Writes a source='reaction' row through the
  // normal message pipeline; toggle semantics live in the tool.
  registry.register(reactToMessageTool.toTool(), reactToMessageTool, { exposure: 'deferred' });

  // Plan 525 Phase 4: Plan tools — unified built-in tool for duya project plan
  // management. Single tool with three actions (status/search/complete) replaces
  // the previous MCP-server-based implementation and stays directly callable.
  registry.register(planTool.toTool(), planTool, { exposure: 'eager' });

  // Plan 552 Phase 0 + plan 575 follow-up: computer-use tools registered
  // so the workflow engine (tool / gui nodes) can enumerate and execute
  // them through the ToolRegistry even when Computer Use mode is off.
  // `deferred` keeps them out of the eager tool list but lets
  // the LLM find them via tool_catalog and call them via tool_invoke
  // (schema delivered as a conversation-tail on discovery). Execution
  // is safe without the mode: the Electron side enforces the shared
  // execution guard (revoke + app policy) and the approval channel on
  // every mutating action. computer-use-mode additionally injects them
  // eagerly with the operating prompt.
  for (const tr of getComputerUseToolsWithDecide(false)) {
    registry.register(tr.definition, tr.executor, {
      exposure: 'deferred',
      inputSchemaSummary: 'computer-use actions (capture/click/type/key/scroll/drag/set_value/wait/zoom + delegated decide loop)',
    });
  }

  // Plan 575: the 14-tool ZCode-aligned CUA surface. Same registration
  // policy as plan 552 — deferred (findable via tool_catalog,
  // invokable via tool_invoke) rather than always-on; workflow engine
  // and tests execute it through the registry directly.
  registry.register(computerCuaDefinition, computerCuaExecutor, {
    exposure: 'deferred',
    inputSchemaSummary: 'CUA tools (list_apps/list_windows/get_app_state/left_click/scroll/type/set_value/select_text/key/perform_action/paste/request_access/stop)',
  });

  return registry;
}

// Export tool definitions for advanced users
export { ToolRegistry } from './registry.js';
export { BashTool } from './BashTool/BashTool.js';
export { PowerShellTool } from './PowerShellTool/PowerShellTool.js';
export { ReadTool, readFileContent } from './ReadTool/ReadTool.js';
export { WriteTool } from './WriteTool/WriteTool.js';
export { GrepTool } from './GrepTool/GrepTool.js';
export { EditTool, editTool, executeEdit } from './EditTool/EditTool.js';
export { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
export { MemoryWriteTool } from './MemoryWriteTool/MemoryWriteTool.js';
export { WriteStage1PolicyTool } from './WriteStage1PolicyTool/WriteStage1PolicyTool.js';
export { SendArtifactTool } from './SendArtifactTool/SendArtifactTool.js';
export { getAgentDefinitions, getPrompt } from './SubagentTool/index.js';
export type { AgentDefinition, SubagentToolInput } from './SubagentTool/index.js';

// Phase 5 tools exports
export { todoTool, TODO_TOOL_NAME, LEGACY_TODO_WIRE_NAMES } from './TodoTool/TodoTool.js';
export { getTaskOutputTool, GET_TASK_OUTPUT_TOOL_NAME, MAX_MULTI_TASK_IDS, DEFAULT_TOOL_OUTPUT_BYTES } from './BackgroundTaskTool/GetTaskOutputTool.js';
export { killTaskTool, KILL_TASK_TOOL_NAME } from './BackgroundTaskTool/KillTaskTool.js';
export { enterPlanModeTool } from './EnterPlanModeTool/EnterPlanModeTool.js';
export { exitPlanModeTool } from './ExitPlanModeTool/ExitPlanModeTool.js';
export { switchModeTool } from './SwitchModeTool/SwitchModeTool.js';
export { browserTool } from './BrowserTool/BrowserTool.js';
export { skillTool } from './SkillTool/SkillTool.js';
export { briefTool } from './BriefTool/BriefTool.js';
export { VisionTool } from './VisionTool/VisionTool.js';
export { imageGenerateTool, IMAGE_GENERATE_TOOL_NAME, ImageGenerateTool } from './ImageGenerateTool/index.js';
export { messageSessionTool, MessageSessionTool } from './MessageSessionTool/index.js';
// cronTool removed in plan 99 — use `duya_cli` (command: 'cron') instead.
// duyaConfigTool removed in plan 102 — use `duya_cli` (argv: 'config …' / 'mcp …') instead.
export { duyaCliTool } from './DuyaCliTool/index.js';
export { updateStateTool, UpdateStateTool, setMemoryTierBridge } from './UpdateStateTool/index.js';
export { UPDATE_STATE_TOOL_NAME } from './UpdateStateTool/index.js';
export { sendMessageTool, SendMessageTool, SEND_MESSAGE_TOOL_NAME } from './SendMessageTool/index.js';
export { sendToAgentTool, SendToAgentTool, SEND_TO_AGENT_TOOL_NAME } from './SendToAgentTool/index.js';
export { postToRoomTool, PostToRoomTool, POST_TO_ROOM_TOOL_NAME } from './PostToRoomTool/index.js';
export { reactToMessageTool, ReactToMessageTool, REACT_TO_MESSAGE_TOOL_NAME, resolveReactToMessage } from './ReactToMessageTool/index.js';
export {
  createAgentTool,
  updateAgentTool,
  CreateAgentTool,
  UpdateAgentTool,
  CREATE_AGENT_TOOL_NAME,
  UPDATE_AGENT_TOOL_NAME,
} from './AgentManagementTool/index.js';
export {
  manageRoutineTool,
  ManageRoutineTool,
  MANAGE_ROUTINE_TOOL_NAME,
  MAX_ROUTINES_PER_BOT,
} from './ManageRoutineTool/index.js';

// Plan tools (Plan 525 Phase 4 — unified built-in, replaced MCP implementation)
export { planTool } from './PlanTool/index.js';
export { PLAN_TOOL_NAME } from './PlanTool/index.js';


