import { z } from 'zod/v4';
import { DUYA_CONFIG_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { configDb } from '../../ipc/db-client.js';

const actionSchema = z.enum([
  'providers_list',
  'provider_add',
  'provider_remove',
  'provider_activate',
  'settings_get',
  'settings_set',
  'vision_get',
  'vision_set',
  'style_get',
  'style_set',
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
          'providers_list', 'provider_add', 'provider_remove', 'provider_activate',
          'settings_get', 'settings_set', 'vision_get', 'vision_set',
          'style_get', 'style_set',
        ],
        description: 'Config action to perform',
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
        case 'providers_list': {
          const providers = await configDb.providerGetAll();
          const all = providers as Record<string, Record<string, unknown>> | undefined;
          const list = all ? Object.values(all).map((p) => ({
            id: p.id,
            name: p.name,
            providerType: p.providerType,
            isActive: p.isActive,
            baseUrl: p.baseUrl,
          })) : [];
          return toolSuccess({ providers: list, count: list.length });
        }

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
          if (!data.provider && !data.model) {
            return toolError('provider or model is required for vision_set');
          }
          const patch: Record<string, unknown> = {};
          if (data.provider) patch.provider = data.provider;
          if (data.model) patch.model = data.model;
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

        default:
          return toolError(`Unknown action: ${(data as Record<string, unknown>).action}`);
      }
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export const duyaConfigTool = new DuyaConfigTool();