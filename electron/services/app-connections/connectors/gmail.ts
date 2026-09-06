/**
 * Gmail connector — Plan 503 P6 (independent provider, separate OAuth consent).
 *
 * A cohesive read + send workflow: search the connected mailbox for a message,
 * read one message's body and headers, and send a plain-text email. Every
 * success keeps the caller's full message via the Gmail message id so the
 * Agent can follow up on a specific thread. Tokens never leave the main
 * process.
 */

import type { ConnectorInputSchema } from '../connector-types.js';
import type {
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';

const PROVIDER = asAppConnectorId('gmail');
const GMAIL_SEARCH_ACTION = 'gmail.search';
const GMAIL_READ_ACTION = 'gmail.read';
const GMAIL_SEND_ACTION = 'gmail.send';
const GMAIL_DRAFT_ACTION = 'gmail.draft';
const GMAIL_MARK_READ_ACTION = 'gmail.markRead';

interface GmailMessageHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
  headers?: GmailMessageHeader[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  labelIds?: string[];
}

interface MessageListEntry {
  id: string;
  threadId: string;
  snippet?: string;
  headers?: GmailMessageHeader[];
}

const messageSearchSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Gmail search expression (e.g. "from:alice has:attachment newer_than:7d"). Omit to browse the inbox.' },
    maxResults: { type: 'number', description: 'Max messages to return (1-50). Default 10.' },
  },
  required: [],
};

const messageReadSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Gmail message ID (from a search result).' },
  },
  required: ['id'],
};

const sendEmailSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    to: { type: 'array', description: 'Recipient email addresses.', items: { type: 'string' } },
    subject: { type: 'string', description: 'Email subject line.' },
    body: { type: 'string', description: 'Plain-text email body.' },
    cc: { type: 'array', description: 'Optional CC recipients.', items: { type: 'string' }, required: [] },
    bcc: { type: 'array', description: 'Optional BCC recipients.', items: { type: 'string' }, required: [] },
  },
  required: ['to', 'subject', 'body'],
};

const draftEmailSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    to: { type: 'array', description: 'Recipient email addresses (optional — can set before sending a draft).', items: { type: 'string' } },
    subject: { type: 'string', description: 'Email subject line.' },
    body: { type: 'string', description: 'Plain-text email body.' },
    cc: { type: 'array', description: 'Optional CC recipients.', items: { type: 'string' }, required: [] },
    bcc: { type: 'array', description: 'Optional BCC recipients.', items: { type: 'string' }, required: [] },
    threadId: { type: 'string', description: 'Optional Gmail thread ID to draft a reply inside.' },
  },
  required: ['subject'],
};

const markReadSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Gmail message ID to mark read.' },
    threadId: { type: 'string', description: 'Optional Gmail thread ID to mark the whole thread read instead of one message.' },
  },
  required: [],
};

/** Build the descriptor list for a single connection. */
export function listGmailDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'gmail_search_messages',
      description: 'Search a connected Gmail account for messages and return summaries (sender, subject, snippet, date). Read-only. Use before reading a message.',
      inputSchema: messageSearchSchema,
      inputSchemaSummary: 'query?: Gmail search expression; maxResults?: number (1-50, default 10). Returns message id + sender + subject + snippet.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: GMAIL_SEARCH_ACTION,
    },
    {
      name: 'gmail_read_message',
      description: 'Read the full body and headers of one Gmail message by id. Read-only.',
      inputSchema: messageReadSchema,
      inputSchemaSummary: 'id: Gmail message ID. Returns subject, from, to, date, and text body.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: GMAIL_READ_ACTION,
    },
    {
      name: 'gmail_send_email',
      description: 'Send a plain-text email from the connected Gmail account. This sends real mail to the recipients.',
      inputSchema: sendEmailSchema,
      inputSchemaSummary: 'to: string[]; subject; body; cc?: string[]; bcc?: string[]. Sends the email and returns the new message id.',
      riskTier: 'write',
      provider: PROVIDER,
      connectionId,
      action: GMAIL_SEND_ACTION,
    },
    {
      name: 'gmail_draft_email',
      description: 'Create an unsent email draft in the connected Gmail account. Nothing is delivered until the user explicitly sends it.',
      inputSchema: draftEmailSchema,
      inputSchemaSummary: 'subject; to?/cc?/bcc?: string[]; body?; threadId? (reply draft). Stores an unsent draft and returns its id.',
      riskTier: 'draft',
      provider: PROVIDER,
      connectionId,
      action: GMAIL_DRAFT_ACTION,
    },
    {
      name: 'gmail_mark_read',
      description: 'Mark one Gmail message (or a whole thread by threadId) as read by removing the UNREAD label. Changes the read state the user sees.',
      inputSchema: markReadSchema,
      inputSchemaSummary: 'id? (message ID) and/or threadId?. Marks the message or whole thread read; returns the resulting label ids.',
      riskTier: 'modify',
      provider: PROVIDER,
      connectionId,
      action: GMAIL_MARK_READ_ACTION,
    },
  ];
}

async function searchGmailMessages(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const query = stringValue(input.query);
  const maxResults = clampNumber(input.maxResults, 10, 1, 50);
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('maxResults', String(maxResults));
  // format=metadata returns the key headers (From/To/Subject/Date) so we can
  // present a useful list without issuing a full request per message.
  url.searchParams.set('format', 'metadata');
  url.searchParams.set('metadataHeaders', 'From');
  url.searchParams.set('metadataHeaders', 'Subject');
  url.searchParams.set('metadataHeaders', 'Date');
  if (query) url.searchParams.set('q', query);
  const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return gmailFailure('search messages', response.status);
  const data = (await response.json()) as { messages?: MessageListEntry[] };
  return {
    success: true,
    data: {
      messages: (data.messages ?? []).map((entry) => ({
        id: entry.id,
        threadId: entry.threadId,
        snippet: entry.snippet,
        subject: headerValue(entry.headers, 'Subject'),
        from: headerValue(entry.headers, 'From'),
        date: headerValue(entry.headers, 'Date'),
      })),
    },
  };
}

async function readGmailMessage(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const id = stringValue(input.id);
  if (!id || !isGmailId(id)) return invalidArguments('id must be a valid Gmail message ID');
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(id));
  url.searchParams.set('format', 'full');
  const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return gmailFailure('read message', response.status);
  const message = (await response.json()) as GmailMessage;
  if (!message.payload) return invalidArguments('Gmail did not return message content');
  return {
    success: true,
    data: {
      id: message.id,
      threadId: message.threadId,
      snippet: message.snippet,
      subject: headerValue(message.payload.headers, 'Subject'),
      from: headerValue(message.payload.headers, 'From'),
      to: headerValue(message.payload.headers, 'To'),
      date: headerValue(message.payload.headers, 'Date'),
      body: extractBodyText(message.payload),
      labelIds: message.labelIds ?? [],
    },
  };
}

async function sendGmailEmail(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const to = stringArray(input.to);
  const subject = stringValue(input.subject);
  const body = stringValue(input.body);
  if (to.length === 0) return invalidArguments('to must contain at least one recipient email address');
  if (!subject) return invalidArguments('subject is required');
  if (!body) return invalidArguments('body is required');

  const raw = buildRfc822Message(to, stringArray(input.cc), stringArray(input.bcc), subject, body);
  const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
  });
  if (!response.ok) return gmailFailure('send email', response.status);
  const sent = (await response.json()) as { id?: string; threadId?: string };
  return {
    success: true,
    data: {
      id: sent.id,
      threadId: sent.threadId,
      sentTo: to,
      subject,
    },
  };
}

async function draftGmailEmail(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const to = stringArray(input.to);
  const subject = stringValue(input.subject);
  if (!subject) return invalidArguments('subject is required');
  const raw = buildRfc822Message(to, stringArray(input.cc), stringArray(input.bcc), subject, stringValue(input.body) ?? '');
  const payload: Record<string, unknown> = {
    message: { raw: Buffer.from(raw, 'utf8').toString('base64url') },
  };
  const threadId = stringValue(input.threadId);
  if (threadId) payload.threadId = threadId;
  const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return gmailFailure('create draft', response.status);
  const draft = (await response.json()) as { id?: string; message?: { id?: string; threadId?: string } };
  return {
    success: true,
    data: {
      id: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      subject,
      sentTo: to,
    },
  };
}

async function markGmailRead(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const id = stringValue(input.id);
  const threadId = stringValue(input.threadId);
  if (!id && !threadId) return invalidArguments('Provide id (message) or threadId to mark read');
  const target = threadId ?? id!;
  const scope = threadId ? 'threads' : 'messages';
  const response = await fetchImpl(
    'https://gmail.googleapis.com/gmail/v1/users/me/' + scope + '/' + encodeURIComponent(target) + '/modify',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    },
  );
  if (!response.ok) return gmailFailure('mark read', response.status);
  const modified = (await response.json()) as { id?: string; labelIds?: string[] };
  return {
    success: true,
    data: {
      scope,
      id: modified.id ?? target,
      labelIds: modified.labelIds ?? [],
    },
  };
}

/** Build a minimal RFC 5322 message for the Gmail API (no attachments). */
function buildRfc822Message(
  to: string[],
  cc: string[],
  bcc: string[],
  subject: string,
  body: string,
): string {
  const lines: string[] = [];
  if (to.length > 0) lines.push('To: ' + to.join(', '));
  if (cc.length > 0) lines.push('Cc: ' + cc.join(', '));
  lines.push('Subject: ' + sanitizeHeader(subject));
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(body.replace(/\r?\n/g, '\r\n'));
  return lines.join('\r\n');
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

function extractBodyText(payload: GmailMessagePart): string {
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts ?? []) {
    if (!part.mimeType) continue;
    if (part.mimeType === 'text/plain') {
      const text = part.body?.data ? decodeBase64Url(part.body.data) : '';
      if (text) return text;
    }
  }
  // Fall back to the first text part of any kind.
  for (const part of payload.parts ?? []) {
    const text = part.body?.data ? decodeBase64Url(part.body.data) : '';
    if (text) return text;
  }
  return '';
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function headerValue(headers: GmailMessageHeader[] | undefined, name: string): string | undefined {
  const match = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value?.trim() || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const trimmed = typeof item === 'string' ? item.trim() : '';
    if (trimmed) out.push(trimmed);
  }
  return [...new Set(out)];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function isGmailId(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,}$/.test(value);
}

function gmailFailure(action: string, status: number): ConnectorInvokeResult {
  return {
    success: false,
    error: { code: 'http_' + status, message: 'Gmail ' + action + ' failed: ' + status, retriable: status >= 500 },
  };
}

function invalidArguments(message: string): ConnectorInvokeResult {
  return { success: false, error: { code: 'invalid_arguments', message, retriable: false } };
}

/** Construct a Gmail connector module bound to a custom fetch (tests). */
export function createGmailConnector(fetchImpl: typeof fetch = fetch): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listGmailDescriptors(connectionId);
    },
    async invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult> {
      if (action === GMAIL_SEARCH_ACTION) return searchGmailMessages(args, accessToken, fetchImpl);
      if (action === GMAIL_READ_ACTION) return readGmailMessage(args, accessToken, fetchImpl);
      if (action === GMAIL_SEND_ACTION) return sendGmailEmail(args, accessToken, fetchImpl);
      if (action === GMAIL_DRAFT_ACTION) return draftGmailEmail(args, accessToken, fetchImpl);
      if (action === GMAIL_MARK_READ_ACTION) return markGmailRead(args, accessToken, fetchImpl);
      return {
        success: false,
        error: { code: 'unknown_action', message: 'Unknown gmail action: ' + action, retriable: false },
      };
    },
  };
}