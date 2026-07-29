/**
 * Microsoft 365 connector — Plan 312 Phase 3.
 *
 * Smoke toolset (read-only). The full Microsoft 365 tool catalog
 * (Mail / Calendar / OneDrive) belongs to Plan 313; this ships only
 * `microsoft_list_messages` so the end-to-end tool injection chain
 * can be exercised.
 */

import type { ConnectorInputSchema } from '../connector-types.js';
import type {
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';

const PROVIDER: ProviderId = 'microsoft365';

const LIST_MESSAGES_ACTION = 'mail.list_messages';

const listMessagesSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    top: {
      type: 'number',
      description: 'Max number of messages to return (1-50). Default 10.',
    },
    folder: {
      type: 'string',
      description: 'Mail folder to list. Default: inbox.',
    },
  },
  required: [],
};

/** Build the descriptor list for a single connection. */
export function listMicrosoft365Descriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'microsoft_list_messages',
      description: 'List messages from the connected Microsoft 365 mailbox. Read-only.',
      inputSchema: listMessagesSchema,
      inputSchemaSummary:
        'top?: number (1-50, default 10); folder?: string (default: inbox). ' +
        'Returns a JSON list of message metadata {id, subject, from, receivedDateTime}.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: LIST_MESSAGES_ACTION,
    },
  ];
}

interface MicrosoftMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
}

interface MicrosoftListResponse {
  value?: MicrosoftMessage[];
}

async function listMessages(
  args: { top?: number; folder?: string },
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<ConnectorInvokeResult> {
  const folder = args.folder || 'inbox';
  const top = Math.min(50, Math.max(1, args.top ?? 10));
  const url = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages`);
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$select', 'id,subject,from,receivedDateTime');

  const resp = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    return {
      success: false,
      error: {
        code: `http_${resp.status}`,
        message: `Microsoft Graph list messages failed: ${resp.status}`,
        retriable: resp.status >= 500,
      },
    };
  }
  const data = (await resp.json()) as MicrosoftListResponse;
  return { success: true, data: data.value ?? [] };
}

/** Construct a Microsoft 365 connector module bound to a custom fetch (tests). */
export function createMicrosoft365Connector(fetchImpl: typeof fetch = fetch): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listMicrosoft365Descriptors(connectionId);
    },
    async invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult> {
      if (action === LIST_MESSAGES_ACTION) {
        const typed = (args ?? {}) as { top?: number; folder?: string };
        return listMessages(typed, accessToken, fetchImpl);
      }
      return {
        success: false,
        error: { code: 'unknown_action', message: `Unknown microsoft365 action: ${action}`, retriable: false },
      };
    },
  };
}
