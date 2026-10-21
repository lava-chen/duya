import { randomUUID } from 'node:crypto';
import { createAIClient, findModelCompat } from '@duya/ai';
import type { ApiFormat, Message } from '@duya/ai';
import type {
  SessionDirectoryScope,
  SessionMatchInfo,
  SessionSearchMessage,
  SessionSearchPort,
  SessionSearchRequest,
  SummaryLLMConfig,
} from '@duya/capabilities/session-search-tool';
import {
  loadRecentSessionDirectory,
  matchesSessionDirectoryScope,
  sanitizeSessionMetadata,
  type RecentSessionRecord,
} from '../worker-session/recent-session-directory.js';
import { getLogger } from '../worker-logger.js';
import { messageDb, sessionDb } from '../worker-db-client.js';

interface SearchSessionRow {
  id: string;
  title: string;
  project_name: string;
  working_directory: string;
  created_at: number;
  model: string;
  parent_id: string | null;
  parent_session_id: string | null;
  snippet?: string;
}

interface SessionParentRow {
  id: string;
  parent_id?: string | null;
  parent_session_id?: string | null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function resolveToParent(sessionId: string, parentMap: Map<string, string | null>): string {
  const visited = new Set<string>();
  let currentId = sessionId;
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const parentId = parentMap.get(currentId);
    if (!parentId) break;
    currentId = parentId;
  }
  return currentId;
}

async function searchSessions(request: SessionSearchRequest): Promise<SessionMatchInfo[]> {
  const searchRows = asRecords(await sessionDb.search(request.query, { limit: request.limit * 4 })) as unknown as SearchSessionRow[];
  if (searchRows.length === 0) return [];

  const sessions = asRecords(await sessionDb.list()) as unknown as SessionParentRow[];
  const parentMap = new Map<string, string | null>();
  for (const session of sessions) {
    parentMap.set(session.id, session.parent_id ?? session.parent_session_id ?? null);
  }

  const currentRoot = request.currentSessionId
    ? resolveToParent(request.currentSessionId, parentMap)
    : null;
  const results = new Map<string, SessionMatchInfo>();

  for (const row of searchRows) {
    const rawSessionId = row.id;
    const resolvedSessionId = resolveToParent(rawSessionId, parentMap);
    if (currentRoot && resolvedSessionId === currentRoot) continue;
    if (request.currentSessionId && rawSessionId === request.currentSessionId) continue;
    if (!matchesSessionDirectoryScope(row.working_directory, request.workingDirectory, request.scope)) continue;

    if (!results.has(rawSessionId)) {
      results.set(rawSessionId, {
        sessionId: rawSessionId,
        title: sanitizeSessionMetadata(row.title, 'Untitled'),
        projectName: sanitizeSessionMetadata(row.project_name, 'Unknown project'),
        source: 'cli',
        sessionStarted: row.created_at,
        model: row.model,
        snippet: row.snippet ?? '',
      });
    }
    if (results.size >= request.limit) break;
  }

  return [...results.values()];
}

function normalizeMessageRow(row: Record<string, unknown>): SessionSearchMessage {
  return {
    role: typeof row.role === 'string' ? row.role : 'unknown',
    content: stringValue(row.content) ?? stringValue(row.display_content),
    tool_name: stringValue(row.tool_name),
    tool_input: stringValue(row.tool_input),
  };
}

async function* streamSummary(
  config: SummaryLLMConfig,
  request: { systemPrompt: string; userPrompt: string; maxTokens: number },
): AsyncIterable<string> {
  const apiFormat: ApiFormat = config.provider === 'anthropic' ? 'anthropic' : 'openai-chat';
  const modelCapabilities = findModelCompat(apiFormat, config.model);
  const client = createAIClient({
    apiKey: config.apiKey,
    model: config.model,
    baseURL: config.baseURL || '',
    apiFormat,
    providerId: config.provider,
    ...(modelCapabilities ? { modelCapabilities } : {}),
  });
  const messages: Message[] = [
    { role: 'user', content: request.userPrompt, id: randomUUID(), timestamp: Date.now() },
  ];
  for await (const event of client.streamChat(messages, {
    systemPrompt: request.systemPrompt,
    maxTokens: request.maxTokens,
  })) {
    if (event.type === 'text') yield event.data;
  }
}

/** Host owns canonical session/message reads and the concrete summarizer client. */
export function createWorkerSessionSearchPort(): SessionSearchPort {
  const logger = getLogger();
  return {
    async searchSessions(request) {
      return searchSessions(request);
    },
    async loadRecentSessionDirectory(options) {
      const rows = asRecords(await sessionDb.list()) as unknown as RecentSessionRecord[];
      return loadRecentSessionDirectory(options, async () => rows);
    },
    async getMessages(sessionId) {
      return asRecords(await messageDb.getBySession(sessionId)).map(normalizeMessageRow);
    },
    streamSummary,
    warn(message, context) {
      logger.warn(message, context, 'SessionSearch');
    },
  };
}
