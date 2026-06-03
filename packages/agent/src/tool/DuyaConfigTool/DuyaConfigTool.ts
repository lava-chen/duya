import { z } from 'zod/v4';
import { DUYA_CONFIG_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { configDb } from '../../ipc/db-client.js';

// v0: only GUI-only actions. Reads that overlap with the CLI
// control plane (providers_list, mcp_server_list) were removed in
// Phase 8 of plan 96; use `duya_cli` for those.
const actionSchema = z.enum([
  'provider_add',
  'provider_remove',
  'provider_activate',
  'settings_get',
  'settings_set',
  'vision_get',
  'vision_set',
  'style_get',
  'style_set',
  'pairing_list',
  'pairing_approve',
  'pairing_revoke',
  'pairing_is_approved',
  'mcp_server_add',
  'mcp_server_remove',
  'mcp_server_assign',
]);

const inputSchema = z.object({
  action: actionSchema,
  id: z.string().optional(),
  name: z.string().optional(),
  providerType: z.enum(['openai', 'anthropic', 'ollama', 'openai-compatible', 'gemini', 'deepseek']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  isActive: z.boolean().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  enableThinking: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  provider: z.string().optional(),
  styleId: z.string().optional(),
  platform: z.string().optional(),
  code: z.string().optional(),
  platformUserId: z.string().optional(),
  serverName: z.string().optional(),
  mcpCommand: z.string().optional(),
  mcpArgs: z.array(z.string()).optional(),
  mcpEnv: z.record(z.string(), z.string()).optional(),
  agentIds: z.array(z.string()).optional(),
});
function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_CONFIG_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_CONFIG_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class DuyaConfigTool implements Tool, ToolExecutor {
  readonly name = DUYA_CONFIG_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'provider_add', 'provider_remove', 'provider_activate',
          'settings_get', 'settings_set', 'vision_get', 'vision_set',
          'style_get', 'style_set',
          'pairing_list', 'pairing_approve', 'pairing_revoke', 'pairing_is_approved',
          'mcp_server_add', 'mcp_server_remove', 'mcp_server_assign',
        ],
        description: 'Config action to perform (write / GUI-only — read-only queries go through `duya_cli`)',
      },
      id: { type: 'string', description: 'Provider ID' },
      name: { type: 'string', description: 'Provider display name' },
      providerType: { type: 'string', enum: ['openai', 'anthropic', 'ollama', 'openai-compatible', 'gemini', 'deepseek'], description: 'Provider type' },
      baseUrl: { type: 'string', description: 'API base URL' },
      apiKey: { type: 'string', description: 'API key (stored encrypted)' },
      isActive: { type: 'boolean', description: 'Set as active provider' },
      model: { type: 'string', description: 'Model name' },
      maxTokens: { type: 'number', description: 'Max tokens per response' },
      temperature: { type: 'number', description: 'Temperature (0-2)' },
      topP: { type: 'number', description: 'Top-p sampling (0-1)' },
      topK: { type: 'number', description: 'Top-k sampling' },
      enableThinking: { type: 'boolean', description: 'Enable extended thinking' },
      thinkingBudget: { type: 'number', description: 'Thinking token budget' },
      provider: { type: 'string', description: 'Vision provider name' },
      styleId: { type: 'string', description: 'Output style ID' },
      platform: { type: 'string', description: 'Platform name (telegram, weixin, qq, feishu, discord, whatsapp)' },
      code: { type: 'string', description: '8-character pairing code to approve' },
      platformUserId: { type: 'string', description: 'Platform user ID to check or revoke' },
      serverName: { type: 'string', description: 'MCP server name (unique identifier)' },
      mcpCommand: { type: 'string', description: 'Command to run the MCP server (npx, uvx, node, etc.)' },
      mcpArgs: { type: 'array', items: { type: 'string' }, description: 'Command arguments array' },
      mcpEnv: { type: 'object', description: 'Environment variables (key-value object)' },
      agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent profile IDs allowed to use this server. Empty means all agents.' },
    },
    required: ['action'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    } as Tool;
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(`Invalid input: ${parsed.error.message}`);
    }

    const data = parsed.data;

    try {
      switch (data.action) {
        case 'provider_add': {
          if (!data.id || !data.name || !data.providerType) {
            return toolError('id, name, and providerType are required for provider_add');
          }
          const result = await configDb.providerUpsert({
            id: data.id,
            name: data.name,
            providerType: data.providerType,
            baseUrl: data.baseUrl || '',
            apiKey: data.apiKey || '',
            isActive: data.isActive ?? false,
          });
          return toolSuccess({ ok: true, provider: { id: data.id, name: data.name }, raw: result });
        }

        case 'provider_remove': {
          if (!data.id) return toolError('id is required for provider_remove');
          const result = await configDb.providerDelete(data.id);
          return toolSuccess({ ok: true, removed: data.id, raw: result });
        }

        case 'provider_activate': {
          if (!data.id) return toolError('id is required for provider_activate');
          const result = await configDb.providerActivate(data.id);
          return toolSuccess({ ok: true, active: data.id, raw: result });
        }

        case 'settings_get': {
          const settings = await configDb.agentGetSettings();
          return toolSuccess(settings);
        }

        case 'settings_set': {
          const patch: Record<string, unknown> = {};
          if (data.model !== undefined) patch.model = data.model;
          if (data.maxTokens !== undefined) patch.maxTokens = data.maxTokens;
          if (data.temperature !== undefined) patch.temperature = data.temperature;
          if (data.topP !== undefined) patch.topP = data.topP;
          if (data.topK !== undefined) patch.topK = data.topK;
          if (data.enableThinking !== undefined) patch.enableThinking = data.enableThinking;
          if (data.thinkingBudget !== undefined) patch.thinkingBudget = data.thinkingBudget;

          if (Object.keys(patch).length === 0) {
            return toolError('At least one setting field must be provided');
          }
          const result = await configDb.agentSetSettings(patch);
          return toolSuccess({ ok: true, changes: patch, raw: result });
        }

        case 'vision_get': {
          const settings = await configDb.visionGet();
          return toolSuccess(settings);
        }

        case 'vision_set': {
          if (
            data.provider === undefined
            && data.model === undefined
            && data.baseUrl === undefined
            && data.apiKey === undefined
            && data.isActive === undefined
          ) {
            return toolError('At least one field is required for vision_set: provider, model, baseUrl, apiKey, isActive');
          }
          const patch: Record<string, unknown> = {};
          if (data.provider !== undefined) patch.provider = data.provider;
          if (data.model !== undefined) patch.model = data.model;
          if (data.baseUrl !== undefined) patch.baseUrl = data.baseUrl;
          if (data.apiKey !== undefined) patch.apiKey = data.apiKey;
          if (data.isActive !== undefined) patch.enabled = data.isActive;
          const result = await configDb.visionSet(patch);
          return toolSuccess({ ok: true, changes: patch, raw: result });
        }

        case 'style_get': {
          const styles = await configDb.outputStylesGet();
          return toolSuccess(styles);
        }

        case 'style_set': {
          if (!data.styleId) return toolError('styleId is required for style_set');
          const result = await configDb.outputStylesSet({ styleId: data.styleId });
          return toolSuccess({ ok: true, styleId: data.styleId, raw: result });
        }

        case 'pairing_list': {
          const pending = await configDb.pairingListPending();
          const approved = await configDb.pairingListApproved();
          return toolSuccess({ pending, approved });
        }

        case 'pairing_approve': {
          if (!data.platform || !data.code) {
            return toolError('platform and code are required for pairing_approve');
          }
          const result = await configDb.pairingApprove(data.platform, data.code);
          return toolSuccess(result);
        }

        case 'pairing_revoke': {
          if (!data.platform || !data.platformUserId) {
            return toolError('platform and platformUserId are required for pairing_revoke');
          }
          const result = await configDb.pairingRevoke(data.platform, data.platformUserId);
          return toolSuccess({ revoked: result });
        }

        case 'pairing_is_approved': {
          if (!data.platform || !data.platformUserId) {
            return toolError('platform and platformUserId are required for pairing_is_approved');
          }
          const result = await configDb.pairingIsApproved(data.platform, data.platformUserId);
          return toolSuccess(result);
        }

        case 'mcp_server_add': {
          if (!data.serverName || !data.mcpCommand) {
            return toolError('serverName and mcpCommand are required for mcp_server_add');
          }
          const settings = await configDb.agentGetSettings();
          const currentServers = Array.isArray((settings as Record<string, unknown>)?.mcpServers)
            ? (settings as Record<string, unknown>).mcpServers as Array<Record<string, unknown>>
            : [];

          const exists = currentServers.some((s) => s.name === data.serverName);
          if (exists) {
            return toolError(`MCP server "${data.serverName}" already exists. Use mcp_server_assign to modify.`);
          }

          const newServer: Record<string, unknown> = {
            name: data.serverName,
            command: data.mcpCommand,
            enabled: true,
          };
          if (data.mcpArgs && data.mcpArgs.length > 0) newServer.args = data.mcpArgs;
          if (data.mcpEnv && Object.keys(data.mcpEnv).length > 0) newServer.env = data.mcpEnv;
          if (data.agentIds && data.agentIds.length > 0) newServer.allowedAgentIds = data.agentIds;

          const updatedServers = [...currentServers, newServer];
          await configDb.agentSetSettings({ mcpServers: updatedServers });
          return toolSuccess({ ok: true, server: newServer });
        }

        case 'mcp_server_remove': {
          if (!data.serverName) {
            return toolError('serverName is required for mcp_server_remove');
          }
          const settings = await configDb.agentGetSettings();
          const currentServers = Array.isArray((settings as Record<string, unknown>)?.mcpServers)
            ? (settings as Record<string, unknown>).mcpServers as Array<Record<string, unknown>>
            : [];

          const filtered = currentServers.filter((s) => s.name !== data.serverName);
          if (filtered.length === currentServers.length) {
            return toolError(`MCP server "${data.serverName}" not found.`);
          }

          await configDb.agentSetSettings({ mcpServers: filtered });
          return toolSuccess({ ok: true, removed: data.serverName });
        }

        case 'mcp_server_assign': {
          if (!data.serverName) {
            return toolError('serverName is required for mcp_server_assign');
          }
          const settings = await configDb.agentGetSettings();
          const currentServers = Array.isArray((settings as Record<string, unknown>)?.mcpServers)
            ? (settings as Record<string, unknown>).mcpServers as Array<Record<string, unknown>>
            : [];

          const serverIndex = currentServers.findIndex((s) => s.name === data.serverName);
          if (serverIndex === -1) {
            return toolError(`MCP server "${data.serverName}" not found.`);
          }

          const updatedServer = { ...currentServers[serverIndex] };
          if (data.agentIds && data.agentIds.length > 0) {
            updatedServer.allowedAgentIds = data.agentIds;
          } else {
            delete updatedServer.allowedAgentIds;
          }

          const updatedServers = [...currentServers];
          updatedServers[serverIndex] = updatedServer;

          await configDb.agentSetSettings({ mcpServers: updatedServers });
          return toolSuccess({
            ok: true,
            server: data.serverName,
            allowedAgentIds: data.agentIds && data.agentIds.length > 0 ? data.agentIds : 'all',
          });
        }

        default:
          return toolError(`Unknown action: ${(data as Record<string, unknown>).action}`);
      }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export const duyaConfigTool = new DuyaConfigTool();
