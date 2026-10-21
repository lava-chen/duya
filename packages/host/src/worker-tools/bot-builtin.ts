import type { BuiltinRegistryServices } from './services.js';
import { ToolRegistry } from '@duya/host/worker-tool-registry';
import type { ToolUseContext } from '@duya/host/worker-run-contracts';
import { BashTool } from '@duya/host/worker-tool-bindings/bash-tool';
import { ReadTool, readFileContent } from '@duya/capabilities/ReadTool/ReadTool';
import { WriteTool } from '@duya/capabilities/WriteTool/WriteTool';
import { GrepTool } from '@duya/capabilities/GrepTool/GrepTool';
import { EditTool, editTool, executeEdit } from '@duya/capabilities/EditTool/EditTool';
import { ApplyPatchTool, applyPatchTool } from '@duya/capabilities/ApplyPatchTool/ApplyPatchTool';
import { GlobTool, globTool, executeGlob } from '@duya/capabilities/GlobTool/GlobTool';
import { SubagentTool } from '@duya/host/worker-subagents/bound-tool';
import type { SubagentRunDeps } from '@duya/host/worker-subagents/run-agent';
import { todoTool } from '@duya/host/worker-tool-bindings/todo';
import { getTaskOutputTool } from '@duya/host/worker-tools/background-task';
import { killTaskTool } from '@duya/host/worker-tools/background-task';
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
export function createBotRegistry( services: BuiltinRegistryServices, deps: SubagentRunDeps, domainBlockerConfig?: DomainBlockerConfig, options?: {
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
    registerBotTools(registry, deps, services);
    return registry;
}
export function registerBotTools(registry: ToolRegistry, deps: SubagentRunDeps, services: BuiltinRegistryServices): void {
    const bashTool = new BashTool();
    registry.register(bashTool.toTool(), bashTool, { exposure: 'eager' });
    const readTool = new ReadTool();
    registry.register(readTool.toTool(), readTool, { exposure: 'eager' });
    const writeTool = new WriteTool();
    registry.register(writeTool.toTool(), writeTool, { exposure: 'eager' });
    const editToolInstance = new EditTool();
    registry.register(editToolInstance.toTool(), editToolInstance, { exposure: 'eager' });
    registry.register(todoTool.toTool(), todoTool, { exposure: 'eager' });
    registry.register(getTaskOutputTool.toTool(), getTaskOutputTool, { exposure: 'eager', riskTier: 'read' });
    registry.register(killTaskTool.toTool(), killTaskTool, { exposure: 'eager', riskTier: 'write' });
    const toolCatalogTool = new ToolCatalogTool();
    const toolInvokeTool = new ToolInvokeTool();
    registry.register(toolCatalogTool.toTool(), toolCatalogTool, { exposure: 'eager' });
    registry.register(toolInvokeTool.toTool(), toolInvokeTool, { exposure: 'eager' });
    registry.register(sendToAgentTool.toTool(), sendToAgentTool, { exposure: 'eager' });
    registry.register(sendMessageTool.toTool(), sendMessageTool, { exposure: 'eager' });
    registry.register(createAgentTool.toTool(), createAgentTool, { exposure: 'eager' });
    registry.register(updateAgentTool.toTool(), updateAgentTool, { exposure: 'eager' });
    registry.register(manageRoutineTool.toTool(), manageRoutineTool, { exposure: 'eager' });
    registry.register(postToRoomTool.toTool(), postToRoomTool, { exposure: 'eager' });
    registry.register(listAppConnectorsTool.toTool(), listAppConnectorsTool, { exposure: 'eager' });
    registry.register(connectAppTool.toTool(), connectAppTool, { exposure: 'eager' });
    registry.register(sessionTool.toTool(), sessionTool, { exposure: 'eager' });
    registry.register(browserTool.toTool(), browserTool, {
        exposure: 'deferred',
        inputSchemaSummary: 'Search, open, inspect, and interact with webpages using a persistent browser session.',
    });
    registry.register(skillTool, skillTool, { exposure: 'eager' });
    const visionTool = new VisionTool();
    registry.register(visionTool, visionTool, { exposure: 'eager' });
    registry.register(imageGenerateTool.toTool(), imageGenerateTool, {
        exposure: 'deferred',
        inputSchemaSummary: 'prompt (required), size, quality, reference_image, output_path',
    });
    registry.register(planTool.toTool(), planTool, { exposure: 'eager' });
    const grepToolInstance = new GrepTool();
    registry.register(grepToolInstance.toTool(), grepToolInstance, { exposure: 'deferred' });
    registry.register(globTool.toTool(), globTool, { exposure: 'deferred' });
    registry.register(briefTool, briefTool, { exposure: 'deferred' });
    registry.register(sessionSearchTool.toTool(), sessionSearchTool, { exposure: 'deferred' });
    registry.register(messageSessionTool.toTool(), messageSessionTool, { exposure: 'deferred' });
    registry.register(updateStateTool.toTool(), updateStateTool, { exposure: 'deferred' });
    registry.register(services.duyaCliTool.toTool(), services.duyaCliTool, { exposure: 'deferred' });
    registry.register(reactToMessageTool.toTool(), reactToMessageTool, { exposure: 'deferred' });
    registry.register(moduleTool.toTool(), moduleTool, { exposure: 'deferred' });
    const subagentTool = new SubagentTool(deps);
    registry.register(subagentTool.toTool(), subagentTool, { exposure: 'hidden' });
    registry.register(askUserQuestionTool.toTool(), askUserQuestionTool, { exposure: 'hidden' });
    registry.register(applyPatchTool.toTool(), applyPatchTool, { exposure: 'hidden' });
    registry.register(widgetTool.toTool(), widgetTool, { exposure: 'hidden' });
}
