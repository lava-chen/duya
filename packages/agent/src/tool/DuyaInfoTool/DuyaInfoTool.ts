import { DUYA_INFO_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { configDb } from '../../ipc/db-client.js';

function toolSuccess(result: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_INFO_TOOL_NAME,
    result: JSON.stringify(result, null, 2),
  };
}

function toolError(message: string): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_INFO_TOOL_NAME,
    result: JSON.stringify({ error: message }),
    error: true,
  };
}

export class DuyaInfoTool implements Tool, ToolExecutor {
  readonly name = DUYA_INFO_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['all', 'providers', 'agent', 'vision', 'system'],
        description: 'What section of info to get (default: all)',
      },
    },
  };

  toTool(): Tool {
    return this;
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    try {
      const section = (input.section as string) || 'all';

      const result: Record<string, unknown> = {};

      if (section === 'all' || section === 'system') {
        try {
          result.system = await configDb.appInfo();
        } catch {
          result.system = { error: 'Failed to get system info' };
        }
      }

      if (section === 'all' || section === 'providers') {
        try {
          const [allProviders, activeProvider] = await Promise.all([
            configDb.providerGetAll(),
            configDb.providerGetActive(),
          ]);
          const providers = allProviders as Record<string, Record<string, unknown>> | undefined;
          const providerList = providers
            ? Object.values(providers).map((p) => ({
                id: p.id,
                name: p.name,
                providerType: p.providerType,
                isActive: p.isActive,
                maskedKey: typeof p.apiKey === 'string'
                  ? `${p.apiKey.slice(0, 6)}...${p.apiKey.slice(-4)}`
                  : undefined,
              }))
            : [];
          result.providers = {
            count: providerList.length,
            active: activeProvider
              ? { id: (activeProvider as Record<string, unknown>).id, name: (activeProvider as Record<string, unknown>).name, providerType: (activeProvider as Record<string, unknown>).providerType }
              : null,
            all: providerList,
          };
        } catch {
          result.providers = { error: 'Failed to get provider info' };
        }
      }

      if (section === 'all' || section === 'agent') {
        try {
          result.agent = await configDb.agentGetSettings();
        } catch {
          result.agent = { error: 'Failed to get agent settings' };
        }
      }

      if (section === 'all' || section === 'vision') {
        try {
          result.vision = await configDb.visionGet();
        } catch {
          result.vision = { error: 'Failed to get vision settings' };
        }
      }

      return toolSuccess(result);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

export const duyaInfoTool = new DuyaInfoTool();