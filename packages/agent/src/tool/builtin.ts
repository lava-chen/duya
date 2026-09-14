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
import { ApplyPatchTool, applyPatchTool } from './ApplyPatchTool/ApplyPatchTool.js';
import { GlobTool, globTool, executeGlob } from './GlobTool/GlobTool.js';
import { MemoryWriteTool } from './MemoryWriteTool/MemoryWriteTool.js';
import { WriteStage1PolicyTool } from './WriteStage1PolicyTool/WriteStage1PolicyTool.js';
import { SendArtifactTool } from './SendArtifactTool/SendArtifactTool.js';
import { subagentTool } from './SubagentTool/index.js';

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

  // Apply patch tool - unified diff application (Codex format)
  const applyPatchToolInstance = new ApplyPatchTool();
  registry.register(applyPatchToolInstance.toTool(), applyPatchToolInstance, { exposeMode: 'always' });

  // Glob tool
  const globToolInstance = new GlobTool();
  registry.register(globToolInstance.toTool(), globToolInstance, { exposeMode: 'always' });

  // SubagentTool - for spawning sub-agents
  registry.register(subagentTool.toTool(), subagentTool, { exposeMode: 'always' });

  // Memory curation tools — validated writes, registered discoverable so the
  // curator profile can select them via allowedTools.
  const memoryWriteTool = new MemoryWriteTool();
  registry.register(memoryWriteTool.toTool(), memoryWriteTool, { exposeMode: 'discoverable' });
  const writeStage1PolicyTool = new WriteStage1PolicyTool();
  registry.register(writeStage1PolicyTool.toTool(), writeStage1PolicyTool, { exposeMode: 'discoverable' });

  // Phase 5: Todo tool (aligned to Grok todo_write)
  registry.register(todoTool.toTool(), todoTool, { exposeMode: 'always' });

  // Phase 5: Background sub-agent task tools. get_task_output is a read-only
  // status/output snapshot (never blocks — completion arrives as an async
  // <task-notification>); kill_task is a write.
  registry.register(getTaskOutputTool.toTool(), getTaskOutputTool, { exposeMode: 'always', riskTier: 'read' });
  registry.register(killTaskTool.toTool(), killTaskTool, { exposeMode: 'always', riskTier: 'write' });

  // Plan mode controls are available through tool_search when needed.
  registry.register(enterPlanModeTool, enterPlanModeTool, { exposeMode: 'discoverable' });
  registry.register(exitPlanModeTool, exitPlanModeTool, { exposeMode: 'discoverable' });
  registry.register(switchModeTool, switchModeTool, { exposeMode: 'discoverable' });

  // Browser — web search and fetch surface. Large schema (many operations),
  // so hint mode reduces token overhead while keeping it on the initial tool
  // surface. The stub appends argument summary to the description.
  registry.register(browserTool.toTool(), browserTool, { exposeMode: 'hint' });

  // Phase 5: Other tools
  // Skill must be on the initial surface (Skills catalog instructs model to
  // call it); hint mode keeps it surfaced with stub schema to reduce overhead.
  registry.register(skillTool, skillTool, { exposeMode: 'hint' });
  registry.register(briefTool, briefTool, { exposeMode: 'discoverable' });
  registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposeMode: 'discoverable' });
  // Inter-agent communication tool — message another session's agent
  registry.register(messageSessionTool.toTool(), messageSessionTool, { exposeMode: 'discoverable' });
  // Plan 504 — spawn a real project-scoped child session and run it async.
  // Bot-exclusive: not auto-surfaced to general sessions (mirrors
  // send_to_agent); bots get exact-name promotion via BOT_TOOLSET.
  registry.register(sessionTool.toTool(), sessionTool, { exposeMode: 'discoverable' });
  const visionTool = new VisionTool();
  registry.register(visionTool, visionTool, { exposeMode: 'hint' });

  // image_generate — media generation tool (plan image-gen). Registered
  // discoverable: it stays off the default tool surface and is reached via
  // `tool_search`. Config lives under `[image_generation]` in config.toml.
  registry.register(imageGenerateTool.toTool(), imageGenerateTool, {
    exposeMode: 'discoverable',
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
  registry.register(duyaCliTool.toTool(), duyaCliTool, { exposeMode: 'discoverable' });

  // AskUserQuestion tool - prompt the user with multi-choice questions
  registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposeMode: 'always' });

  // ModuleTool - load design specification modules on demand
  // Agent calls read_module BEFORE show_widget or canvas tools to get style guides
  registry.register(moduleTool.toTool(), moduleTool, { exposeMode: 'discoverable' });

  // show_widget — generative UI widgets (charts, diagrams, calculators, mini-apps).
  // Short description kept inline; see WidgetTool for full executor.
  registry.register(widgetTool.toTool(), widgetTool, { exposeMode: 'hint' });

  // send_artifact - explicit outbound file delivery through a gateway channel.
  // Discoverable: gateway sessions reach it via tool_search; in desktop
  // sessions it is a harmless no-op, so keeping it off the default tool
  // surface saves the schema tokens.
  const sendArtifactTool = new SendArtifactTool();
  registry.register(sendArtifactTool.toTool(), sendArtifactTool, { exposeMode: 'discoverable' });

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

  // Plan 480 P2.1: discovery + invocation meta tools. Their names and schemas
  // are byte-constant; dynamic tools (MCP / plugins / connectors) never enter
  // the request's tools array — the model reads their schemas via
  // `tool_schema` and invokes via `tool_invoke`. The catalog provider is
  // injected per-call by the agent (like toolSearchTool.setSearchFn); the
  // invocation dispatcher is wired in P2.2 (permission gate) / P3.
  registry.register(toolSchemaTool.toTool(), toolSchemaTool, { exposeMode: 'always' });
  registry.register(toolInvokeTool.toTool(), toolInvokeTool, { exposeMode: 'always' });

  // Plan 481 T1: update_state — bot memory/state writes through the 479 tier
  // store (see UpdateStateTool). Discoverable: only bot profiles surface it
  // (bot-toolset.ts appends it to allowedTools); checkPermissions maps
  // own=allow / shared=ask per the 481 permission matrix.
  registry.register(updateStateTool.toTool(), updateStateTool, { exposeMode: 'discoverable' });

  // Plan 483 P2: SendMessage — bot proactive message delivery to the UI.
  // Based on grok-bot SendMessage semantics: this is the ONLY way for a bot to
  // communicate with the user. Plain assistant text is invisible.
  // Discoverable: only bot profiles surface it (bot-toolset.ts appends it to
  // allowedTools). The message is saved to DB and pushed to the renderer via
  // SSE broadcast in the message:append handler.
  registry.register(sendMessageTool.toTool(), sendMessageTool, { exposeMode: 'discoverable' });

  // Plan 477 P1.2: send_to_agent — asynchronous agent-to-agent DM. The
  // message lands in the target's agent_mailbox (kind='agent_dm') and the
  // 476 wake bus handles waking the recipient. Discoverable: bot profiles
  // surface it via the BOT_TOOLSET exact-name promotion (plan 496).
  registry.register(sendToAgentTool.toTool(), sendToAgentTool, { exposeMode: 'discoverable' });

  // Plan 478 P2.1: post_to_room — a member's only voice into a shared room
  // (grok group SendMessage parity). The authored entry lands directly in the
  // room transcript session (`room:<roomId>`); the main process hooks the
  // append for room sessions and drives the round-robin orchestrator.
  // Discoverable: surfaced via the BOT_TOOLSET exact-name promotion.
  registry.register(postToRoomTool.toTool(), postToRoomTool, { exposeMode: 'discoverable' });

  // Plan 492 P4: create_agent / update_agent — bot self-management (grok
  // sand-agent-management-tools parity). Persistence goes through the
  // db-bridge config:agents:create|update cases; the main process owns the
  // config.toml write. Discoverable: bot profiles surface them via
  // BOT_TOOLSET; main-session '*' profiles stay behind tool_search.
  registry.register(createAgentTool.toTool(), createAgentTool, { exposeMode: 'discoverable' });
  registry.register(updateAgentTool.toTool(), updateAgentTool, { exposeMode: 'discoverable' });

  // Plan 476 P2.3b: manage_routine — bot routine self-management (grok
  // update_state target "routine" parity). Persistence goes through the
  // db-bridge automation:cron:* cases; the tool enforces bot ownership
  // agent-side (bridge has no session context). Discoverable: bot profiles
  // surface it via BOT_TOOLSET; main sessions cannot own routines.
  registry.register(manageRoutineTool.toTool(), manageRoutineTool, { exposeMode: 'discoverable' });

  // Plan 503: list_app_connectors / connect_app — bot-only connector
  // elicitation (grok AuthenticateMcpServer parity). connect_app shows the
  // user a connect card (chat:connector_auth_required variant 'connect')
  // and never touches tokens; the OAuth flow and resume stay in main + UI.
  // Discoverable: bot profiles surface them via BOT_TOOLSET; interactive
  // main-session agents keep the settings-page connect flow.
  registry.register(listAppConnectorsTool.toTool(), listAppConnectorsTool, { exposeMode: 'discoverable' });
  registry.register(connectAppTool.toTool(), connectAppTool, { exposeMode: 'discoverable' });

  // Plan 490 P1: ReactToMessage — emoji tapback on a chat message (grok
  // sand-reaction-tool parity). Discoverable: reached via tool_search when
  // the model needs it; the schema cost does not justify a permanent slot
  // on the default surface. Writes a source='reaction' row through the
  // normal message pipeline; toggle semantics live in the tool.
  registry.register(reactToMessageTool.toTool(), reactToMessageTool, { exposeMode: 'discoverable' });

  // Plan 525 Phase 4: Plan tools — unified built-in tool for duya project plan
  // management. Single tool with three actions (status/search/complete) replaces
  // the previous MCP-server-based implementation. Exposed as hint level to reduce
  // token overhead while keeping it on the initial tool surface.
  registry.register(planTool.toTool(), planTool, { exposeMode: 'hint' });

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
export { MemoryWriteTool } from './MemoryWriteTool/MemoryWriteTool.js';
export { WriteStage1PolicyTool } from './WriteStage1PolicyTool/WriteStage1PolicyTool.js';
export { SendArtifactTool } from './SendArtifactTool/SendArtifactTool.js';
export { getSubagentToolDefinition, getAgentDefinitions, getPrompt } from './SubagentTool/index.js';
export type { AgentDefinition, SubagentToolInput, SubagentToolResult } from './SubagentTool/index.js';

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


