/**
 * App Connector Management Tools (Plan 503) — bot-only connector
 * elicitation (grok-bot 0.18 sand-mcp-management-tools parity).
 *
 * Boundary: these tools are registered `discoverable` in the builtin
 * registry and surfaced ONLY to bot profiles via the BOT_TOOLSET
 * exact-name promotion (agent-profile/bot-toolset.ts). Interactive
 * main-session agents stay on the settings-page connect flow.
 *
 * Connect contract (mirrors grok's AuthenticateMcpServer and duya's
 * Plan 498 re-authorization card):
 *   1. The bot calls connect_app(provider).
 *   2. The executor emits `chat:connector_auth_required` (variant
 *      `connect`) via sendToMain; the renderer draws the connect card.
 *   3. The tool result instructs the model to STOP retrying and end the
 *      turn — never compose an authorization link, never reach the
 *      service another way while authorization is pending.
 *   4. The user clicks Authorize (OAuth loopback, Plan 312); on
 *      completion the UI sends a follow-up message that resumes the bot.
 *
 * Tokens never enter the agent process: the catalog RPC returns DTOs only.
 */

import { randomUUID } from 'node:crypto';
import type { ToolUseContext } from '../../types.js';

export const LIST_APP_CONNECTORS_TOOL_NAME = 'list_app_connectors';
export const CONNECT_APP_TOOL_NAME = 'connect_app';

interface CatalogProviderDTO {
  id: string;
  label: string;
  configured: boolean;
  configurationHint?: string;
  supportsManualConfiguration?: boolean;
  description?: string;
  scopes?: string[];
}

interface CatalogConnectionDTO {
  id: string;
  provider: string;
  accountLabel?: string;
  status: string;
  lastError?: string | null;
}

interface CatalogResult {
  providers: CatalogProviderDTO[];
  connections: CatalogConnectionDTO[];
}

type IpcResponse = {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

interface ToolResultShape {
  id: string;
  name: string;
  result: string;
  error?: boolean;
}

async function fetchCatalog(context: ToolUseContext): Promise<CatalogResult | { error: string }> {
  if (!context.ipcRequest) {
    return { error: 'IPC not available — connector management requires the main process bridge.' };
  }
  const response: IpcResponse = await context.ipcRequest('appConnection:catalog', {}, { timeout: 15_000 });
  if (!response.success || !response.data) {
    const err = response.error ?? { code: 'UNKNOWN', message: 'Unknown error' };
    return { error: `${err.code}: ${err.message}` };
  }
  return response.data as CatalogResult;
}

// ─── list_app_connectors ────────────────────────────────────────────────

const LIST_DESCRIPTION = [
  'List the app connectors (Gmail-style external services) available in this environment.',
  'Returns every registered provider with its readiness plus each existing connection and its status (connected / disconnected / error).',
  'Use this before connect_app to discover valid provider ids and to check whether a service is already connected.',
].join(' ');

const LIST_SCHEMA = {
  type: 'object' as const,
  properties: {},
  required: [] as string[],
};

export class ListAppConnectorsTool {
  name = LIST_APP_CONNECTORS_TOOL_NAME;
  description = LIST_DESCRIPTION;
  input_schema = LIST_SCHEMA;

  toTool() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    _input: Record<string, unknown>,
    _workingDirectory: string | undefined,
    context: ToolUseContext | undefined
  ): Promise<ToolResultShape> {
    const catalog = await fetchCatalog(context ?? {} as ToolUseContext);
    if ('error' in catalog) {
      return {
        id: randomUUID(),
        name: this.name,
        result: JSON.stringify({ success: false, error: catalog.error }),
        error: true,
      };
    }
    // Compact projection: one row per provider with merged connection state.
    const rows = catalog.providers.map((provider) => {
      const conns = catalog.connections.filter((c) => c.provider === provider.id);
      const connected = conns.find((c) => c.status === 'connected');
      const errored = conns.find((c) => c.status === 'error' || c.lastError);
      return {
        provider: provider.id,
        label: provider.label,
        description: provider.description,
        configured: provider.configured,
        configurationHint: provider.configurationHint,
        defaultScopes: provider.scopes,
        status: connected ? 'connected' : errored ? 'error' : conns.length > 0 ? 'disconnected' : 'not_connected',
        account: connected?.accountLabel ?? conns[0]?.accountLabel,
        lastError: errored?.lastError ?? undefined,
      };
    });
    return {
      id: randomUUID(),
      name: this.name,
      result: JSON.stringify({ success: true, connectors: rows }),
      error: false,
    };
  }
}

// ─── connect_app ────────────────────────────────────────────────────────

const CONNECT_DESCRIPTION = [
  'Start connecting an external app (e.g. Google Drive, Slack, Notion) for the user.',
  'This is the ONLY way to begin a connector authorization: a connect card is shown to the user in the chat automatically.',
  'Never compose an authorization link yourself, never paste OAuth URLs, and never reach the same service through another tool while its authorization is pending.',
  'After calling this tool, finish any other useful work and END YOUR TURN — the UI sends you a follow-up message once the user completes authorization, and you continue then.',
  'If the user has not explicitly asked to connect the app, ask first and call this tool only after they agree.',
].join(' ');

const CONNECT_SCHEMA = {
  type: 'object' as const,
  properties: {
    provider: {
      type: 'string',
      description: 'Provider id from list_app_connectors (e.g. "google", "slack", "notion").',
    },
  },
  required: ['provider'],
};

export class ConnectAppTool {
  name = CONNECT_APP_TOOL_NAME;
  description = CONNECT_DESCRIPTION;
  input_schema = CONNECT_SCHEMA;

  toTool() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory: string | undefined,
    context: ToolUseContext | undefined
  ): Promise<ToolResultShape> {
    const provider = typeof input?.provider === 'string' ? input.provider.trim() : '';
    if (!provider) {
      return {
        id: randomUUID(),
        name: this.name,
        result: 'Invalid input: provider is required (get valid ids from list_app_connectors).',
        error: true,
      };
    }

    const catalog = await fetchCatalog(context ?? {} as ToolUseContext);
    if ('error' in catalog) {
      return {
        id: randomUUID(),
        name: this.name,
        result: JSON.stringify({ success: false, error: catalog.error }),
        error: true,
      };
    }

    const providerConfig = catalog.providers.find((p) => p.id === provider);
    if (!providerConfig) {
      const valid = catalog.providers.map((p) => p.id).join(', ');
      return {
        id: randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: `Unknown provider "${provider}". Valid providers: ${valid || 'none registered'}.`,
        }),
        error: true,
      };
    }

    const existing = catalog.connections.filter((c) => c.provider === provider);
    if (existing.some((c) => c.status === 'connected')) {
      return {
        id: randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: true,
          alreadyConnected: true,
          message: `${providerConfig.label} is already connected — use its connector tools directly.`,
        }),
        error: false,
      };
    }

    if (!context?.sendToMain) {
      return {
        id: randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: 'sendToMain not available — cannot show the connect card to the user.',
        }),
        error: true,
      };
    }

    // Emit the connect elicitation. The renderer draws the connect card
    // (variant 'connect'); the OAuth loopback and the resume follow-up
    // are handled by the UI (Plan 498 pipeline, Plan 503 extension).
    context.sendToMain({
      type: 'chat:connector_auth_required',
      sessionId: context.options?.sessionId,
      toolName: this.name,
      provider,
      variant: 'connect',
    });

    return {
      id: randomUUID(),
      name: this.name,
      result: JSON.stringify({
        success: true,
        cardShown: true,
        message:
          `A connect card for ${providerConfig.label} has been shown to the user in the chat UI. ` +
          'Do NOT retry this call, do not compose an authorization link, and do not reach the service another way while authorization is pending. ' +
          'Finish any other useful work, then END YOUR TURN. The user will complete authorization in the browser, and the UI will automatically send a follow-up message so you can continue.',
      }),
      error: false,
    };
  }
}
