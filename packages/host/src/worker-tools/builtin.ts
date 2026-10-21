import type { BuiltinRegistryServices } from './services.js';
import { ToolRegistry } from '@duya/host/worker-tool-registry';
import type { ToolMetaInput } from '@duya/host/worker-tool-registry';
import type { ToolUseContext } from '@duya/host/worker-run-contracts';
import { BashTool } from '@duya/host/worker-tool-bindings/bash-tool';
import { PowerShellTool } from '@duya/host/worker-tool-bindings/powershell-tool';
import { ApplyPatchTool, applyPatchTool, EditTool, editTool, executeEdit, executeGlob, GlobTool, globTool, GrepTool, ReadTool, readFileContent, WriteTool, } from '@duya/capabilities';
import { MemoryWriteTool } from '@duya/host/worker-tool-bindings/memory-write-tool';
import { WriteStage1PolicyTool } from '@duya/host/worker-tool-bindings/stage1-policy-tool';
import { SendArtifactTool } from '@duya/host/worker-tool-bindings/send-artifact';
import { SubagentTool } from '@duya/host/worker-subagents/bound-tool';
import type { SubagentRunDeps } from '@duya/host/worker-subagents/run-agent';
import { todoTool } from '@duya/host/worker-tool-bindings/todo';
import { getTaskOutputTool } from '@duya/host/worker-tools/background-task';
import { killTaskTool } from '@duya/host/worker-tools/background-task';
import { enterPlanModeTool } from '@duya/host/worker-tool-bindings/enter-plan-mode';
import { exitPlanModeTool } from '@duya/host/worker-tool-bindings/exit-plan-mode';
import { switchModeTool } from '@duya/host/worker-tool-bindings/switch-mode';
import { browserTool } from '@duya/host/worker-tool-bindings/browser-tool';
import type { DomainBlockerConfig } from '@duya/capabilities/BrowserTool/DomainBlocker';
import type { BrowserBackendMode } from '@duya/capabilities/BrowserTool/backend-resolver';
import { skillTool } from '@duya/host/worker-tool-bindings/skill';
import { briefTool } from '@duya/capabilities/BriefTool/BriefTool';
import { sessionSearchTool } from '@duya/host/worker-tool-bindings/session-search';
import { messageSessionTool } from '@duya/host/worker-tool-bindings/message-session';
import { sessionTool } from '@duya/host/worker-tool-bindings/session';
import { VisionTool } from '@duya/capabilities/VisionTool/VisionTool';
import { imageGenerateTool } from '@duya/host/worker-image-generation';
import { askUserQuestionTool } from '@duya/capabilities';
import { moduleTool } from '@duya/capabilities/ModuleTool/ModuleTool';
import { widgetTool } from '@duya/host/worker-widget/tool';
import { hasShellFamily } from '@duya/capabilities/utils/shellDetector';
import { ToolCatalogTool } from '@duya/agent-runtime/tools/discovery/ToolCatalogTool';
import { ToolInvokeTool } from '@duya/agent-runtime/tools/discovery/ToolInvokeTool';
import { updateStateTool } from '@duya/host/worker-tool-bindings/update-state';
import { sendMessageTool } from '@duya/host/worker-tool-bindings/send-message';
import { sendToAgentTool } from '@duya/host/worker-tool-bindings/send-to-agent';
import { postToRoomTool } from '@duya/host/worker-tool-bindings/post-to-room';
import { reactToMessageTool } from '@duya/host/worker-tool-bindings/react-to-message';
import { createAgentTool, updateAgentTool, } from '@duya/host/worker-tool-bindings/agent-management';
import { manageRoutineTool } from '@duya/host/worker-tool-bindings/routine';
import { listAppConnectorsTool, connectAppTool } from '@duya/host/worker-tool-bindings/app-connector-manage-tools';
import { planTool } from '@duya/host/worker-tool-bindings/plan';
import { getComputerUseToolsWithDecide } from '@duya/host/worker-tool-bindings/os-tools';
import { definition as computerCuaDefinition, executor as computerCuaExecutor } from '@duya/host/worker-tool-bindings/computer-cua-tool';
const bashTool = new BashTool();
const powerShellTool = new PowerShellTool();
const writeTool = new WriteTool();
const grepTool = new GrepTool();
export function createBuiltinRegistry( services: BuiltinRegistryServices, deps: SubagentRunDeps, domainBlockerConfig?: DomainBlockerConfig, options?: {
    enabledPluginIds?: Set<string>;
    browserBackendMode?: BrowserBackendMode;
}): ToolRegistry {
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
    registry.register(bashTool.toTool(), bashTool, {
        exposure: 'eager',
    });
    if (hasShellFamily('powershell')) {
        registry.register(powerShellTool.toTool(), powerShellTool, {
            exposure: 'deferred',
        });
    }
    const readTool = new ReadTool();
    registry.register(readTool.toTool(), readTool, { exposure: 'eager' });
    registry.register(writeTool.toTool(), writeTool, { exposure: 'eager' });
    registry.register(grepTool.toTool(), grepTool, { exposure: 'eager' });
    const editToolInstance = new EditTool();
    registry.register(editToolInstance.toTool(), editToolInstance, { exposure: 'eager' });
    const applyPatchToolInstance = new ApplyPatchTool();
    registry.register(applyPatchToolInstance.toTool(), applyPatchToolInstance, { exposure: 'eager' });
    const globToolInstance = new GlobTool();
    registry.register(globToolInstance.toTool(), globToolInstance, { exposure: 'eager' });
    const subagentTool = new SubagentTool(deps);
    registry.register(subagentTool.toTool(), subagentTool, { exposure: 'eager' });
    const memoryWriteTool = new MemoryWriteTool();
    registry.register(memoryWriteTool.toTool(), memoryWriteTool, { exposure: 'deferred' });
    const writeStage1PolicyTool = new WriteStage1PolicyTool();
    registry.register(writeStage1PolicyTool.toTool(), writeStage1PolicyTool, { exposure: 'deferred' });
    registry.register(todoTool.toTool(), todoTool, { exposure: 'eager' });
    registry.register(getTaskOutputTool.toTool(), getTaskOutputTool, { exposure: 'eager', riskTier: 'read' });
    registry.register(killTaskTool.toTool(), killTaskTool, { exposure: 'eager', riskTier: 'write' });
    registry.register(enterPlanModeTool, enterPlanModeTool, { exposure: 'deferred' });
    registry.register(exitPlanModeTool, exitPlanModeTool, { exposure: 'deferred' });
    registry.register(switchModeTool, switchModeTool, { exposure: 'deferred' });
    registry.register(browserTool.toTool(), browserTool, {
        exposure: 'deferred',
        inputSchemaSummary: 'Search, open, inspect, and interact with webpages using a persistent browser session.',
    });
    registry.register(skillTool, skillTool, { exposure: 'eager' });
    registry.register(briefTool, briefTool, { exposure: 'deferred' });
    registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposure: 'deferred' });
    registry.register(messageSessionTool.toTool(), messageSessionTool, { exposure: 'deferred' });
    registry.register(sessionTool.toTool(), sessionTool, { exposure: 'deferred' });
    const visionTool = new VisionTool();
    registry.register(visionTool, visionTool, { exposure: 'eager' });
    registry.register(imageGenerateTool.toTool(), imageGenerateTool, {
        exposure: 'deferred',
        inputSchemaSummary: 'prompt (required), size, quality, reference_image, output_path',
    });
    registry.register(services.duyaCliTool.toTool(), services.duyaCliTool, { exposure: 'deferred' });
    registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposure: 'eager' });
    registry.register(moduleTool.toTool(), moduleTool, { exposure: 'deferred' });
    registry.register(widgetTool.toTool(), widgetTool, {
        exposure: 'deferred',
        inputSchemaSummary: 'Create a chart, diagram, calculator, or small interactive app for the conversation.',
    });
    const sendArtifactTool = new SendArtifactTool();
    registry.register(sendArtifactTool.toTool(), sendArtifactTool, { exposure: 'deferred' });
    const toolCatalogTool = new ToolCatalogTool();
    const toolInvokeTool = new ToolInvokeTool();
    registry.register(toolCatalogTool.toTool(), toolCatalogTool, { exposure: 'eager' });
    registry.register(toolInvokeTool.toTool(), toolInvokeTool, { exposure: 'eager' });
    registry.register(updateStateTool.toTool(), updateStateTool, { exposure: 'deferred' });
    registry.register(sendMessageTool.toTool(), sendMessageTool, { exposure: 'deferred' });
    registry.register(sendToAgentTool.toTool(), sendToAgentTool, { exposure: 'deferred' });
    registry.register(postToRoomTool.toTool(), postToRoomTool, { exposure: 'deferred' });
    registry.register(createAgentTool.toTool(), createAgentTool, { exposure: 'deferred' });
    registry.register(updateAgentTool.toTool(), updateAgentTool, { exposure: 'deferred' });
    registry.register(manageRoutineTool.toTool(), manageRoutineTool, { exposure: 'deferred' });
    registry.register(listAppConnectorsTool.toTool(), listAppConnectorsTool, { exposure: 'deferred' });
    registry.register(connectAppTool.toTool(), connectAppTool, { exposure: 'deferred' });
    registry.register(reactToMessageTool.toTool(), reactToMessageTool, { exposure: 'deferred' });
    registry.register(planTool.toTool(), planTool, { exposure: 'eager' });
    for (const tr of getComputerUseToolsWithDecide(false)) {
        registry.register(tr.definition, tr.executor, {
            exposure: 'deferred',
            inputSchemaSummary: 'computer-use actions (capture/click/type/key/scroll/drag/set_value/wait/zoom + delegated decide loop)',
        });
    }
    registry.register(computerCuaDefinition, computerCuaExecutor, {
        exposure: 'deferred',
        inputSchemaSummary: 'CUA tools (list_apps/list_windows/get_app_state/left_click/scroll/type/set_value/select_text/key/perform_action/paste/request_access/stop)',
    });
    return registry;
}
