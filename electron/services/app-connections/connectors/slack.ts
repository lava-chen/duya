/**
 * Slack connector — Plan 312 Phase 3.
 *
 * Smoke toolset (read-only). The full Slack tool catalog belongs to
 * Plan 313; this ships only `slack_search_messages` so the end-to-end
 * tool injection chain can be exercised.
 */

import type { ConnectorInputSchema } from '../connector-types.js';
import type {
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';

const PROVIDER: ProviderId = 'slack';

const SEARCH_MESSAGES_ACTION = 'search.messages';

const searchMessagesSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Slack search query (e.g. `from:alice after:yesterday`).',
    },
    count: {
      type: 'number',
      description: 'Max number of messages to return (1-100). Default 20.',
    },
  },
  required: ['query'],
};

/** Build the descriptor list for a single connection. */
export function listSlackDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'slack_search_messages',
      description: 'Search messages in the connected Slack workspace. Read-only.',
      inputSchema: searchMessagesSchema,
      inputSchemaSummary:
        'query: string (Slack search syntax); count?: number (1-100, default 20). ' +
        'Returns a JSON list of message metadata {iid, channel, user, username, text, ts}.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: SEARCH_MESSAGES_ACTION,
    },
  ];
}

interface SlackSearchResponse {
  ok: boolean;
  messages?: {
    matches?: Array<Record<string, unknown>>;
    paging?: { count?: number; total?: number; page?: number };
  };
  error?: string;
}

async function searchMessages(
  args: { query: string; count?: number },
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<ConnectorInvokeResult> {
  const url = new URL('https://slack.com/api/search.messages');
  url.searchParams.set('query', args.query);
  url.searchParams.set('count', String(Math.min(100, Math.max(1, args.count ?? 20))));

  const resp = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    return {
      success: false,
      error: {
        code: `http_${resp.status}`,
        message: `Slack search.messages failed: ${resp.status}`,
        retriable: resp.status >= 500,
      },
    };
  }
  const data = (await resp.json()) as SlackSearchResponse;
  if (!data.ok) {
    return {
      success: false,
      error: {
        code: 'slack_error',
        message: `Slack API error: ${data.error ?? 'unknown'}`,
        retriable: false,
      },
    };
  }
  return { success: true, data: data.messages?.matches ?? [] };
}

/** Construct a Slack connector module bound to a custom fetch (tests). */
export function createSlackConnector(fetchImpl: typeof fetch = fetch): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listSlackDescriptors(connectionId);
    },
    async invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult> {
      if (action === SEARCH_MESSAGES_ACTION) {
        const typed = (args ?? {}) as { query: string; count?: number };
        if (!typed.query) {
          return {
            success: false,
            error: { code: 'missing_query', message: 'query is required', retriable: false },
          };
        }
        return searchMessages(typed, accessToken, fetchImpl);
      }
      return {
        success: false,
        error: { code: 'unknown_action', message: `Unknown slack action: ${action}`, retriable: false },
      };
    },
  };
}
