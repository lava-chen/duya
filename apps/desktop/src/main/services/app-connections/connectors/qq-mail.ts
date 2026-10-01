/**
 * QQ Mail connector — pilot (custom-credential provider, IMAP + SMTP).
 *
 * Unlike OAuth providers, QQ Mail has no public OAuth2 for third parties.
 * It authenticates via a 16-digit "authorization code" (授权码) that the
 * user enables under 设置 → 账号与安全 → POP3/IMAP/SMTP/Exchange服务, then
 * uses over IMAP (imap.qq.com:993) for reading and SMTP (smtp.qq.com:465)
 * for sending. The credentials are per-provider and stored in the vault's
 * OAuth-client slot (clientId = email, clientSecret = auth code), exactly
 * like the WeCom custom-credential connector.
 *
 * The auth code is a long-lived, protocol-bound secret: it is never exposed
 * to the renderer or agent, and revoking it happens on the QQ Mail web side.
 *
 * Tokens never leave the main process: the agent only sees descriptors and
 * redacted results through `appConnection:invoke`.
 */

import type {
  ConnectorInputSchema,
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';
import type { TokenVault } from '../token-vault.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

const PROVIDER = asAppConnectorId('qq-mail');

const IMAP_HOST = 'imap.qq.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtp.qq.com';
const SMTP_PORT = 465;

const Qq_SEARCH_ACTION = 'qq-mail.search';
const Qq_READ_ACTION = 'qq-mail.read';
const Qq_SEND_ACTION = 'qq-mail.send';

interface QqCredentials {
  email: string;
  authCode: string;
}

export interface QqMailEnvelope {
  uid: number;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
}

export interface QqMailMessage extends QqMailEnvelope {
  body: string;
}

/** IMAP read/search session. Injectable so the connector is unit-testable. */
export interface QqImapSession {
  search(maxResults: number, query?: string): Promise<QqMailEnvelope[]>;
  read(uid: number): Promise<QqMailMessage | null>;
  close(): Promise<void>;
}

export type ConnectImapFn = (creds: QqCredentials) => Promise<QqImapSession>;

export interface SmtpMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
}

export type SendMailFn = (creds: QqCredentials, mail: SmtpMail) => Promise<void>;

const searchSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Optional text to match against subject or sender.' },
    maxResults: { type: 'number', description: 'Max messages to return (1-20). Default 10.' },
  },
  required: [],
};

const readSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    uid: { type: 'number', description: 'QQ Mail message UID from a search result.' },
  },
  required: ['uid'],
};

const sendSchema: ConnectorInputSchema = {
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

/** Build the descriptor list for a QQ Mail connection. */
export function listQqMailDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'qq_mail_search',
      description: 'Search the INBOX of the connected QQ Mail account and return message summaries (sender, subject, date). Read-only.',
      inputSchema: searchSchema,
      inputSchemaSummary: 'query?: text; maxResults?: number (1-20, default 10). Returns uid + sender + subject + date.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: Qq_SEARCH_ACTION,
    },
    {
      name: 'qq_mail_read',
      description: 'Read the full body and headers of one QQ Mail message by uid. Read-only.',
      inputSchema: readSchema,
      inputSchemaSummary: 'uid: number. Returns subject, from, to, date, and plain-text body.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: Qq_READ_ACTION,
    },
    {
      name: 'qq_mail_send',
      description: 'Send a plain-text email from the connected QQ Mail account via SMTP. Sends real mail to the recipients.',
      inputSchema: sendSchema,
      inputSchemaSummary: 'to: string[]; subject; body; cc?: string[]; bcc?: string[]. Sends via SMTP and returns the accepted recipients.',
      riskTier: 'write',
      provider: PROVIDER,
      connectionId,
      action: Qq_SEND_ACTION,
    },
  ];
}

/** Read the QQ Mail credentials from the vault's per-provider slot. */
function credentialsFromVault(vault: TokenVault): QqCredentials | null {
  const client = vault.getOAuthClient(PROVIDER);
  const email = client?.clientId?.trim();
  const authCode = client?.clientSecret?.trim();
  if (!email || !authCode) return null;
  return { email, authCode };
}

/** Default IMAP client backed by imapflow (imap.qq.com:993). */
const defaultConnectImap: ConnectImapFn = async (creds) => {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: creds.email, pass: creds.authCode },
    logger: false,
  });
  await client.connect();
  await client.mailboxOpen('INBOX');
  return {
    async search(maxResults, query) {
      const needle = query?.trim().toLowerCase();
      const envelopes: QqMailEnvelope[] = [];
      for await (const msg of client.fetch('1:*', { envelope: true, uid: true })) {
        const env = envelopeFromFetch(msg as unknown as QqFetchMessage);
        if (!env) continue;
        if (needle && !matches(env, needle)) continue;
        envelopes.push(env);
      }
      envelopes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return envelopes.slice(0, maxResults);
    },
    async read(uid) {
      let matched: QqMailMessage | null = null;
      for await (const msg of client.fetch(String(uid), { source: true, envelope: true, uid: true })) {
        const env = envelopeFromFetch(msg as unknown as QqFetchMessage);
        if (!env) continue;
        const source = msg.source;
        const text =
          source instanceof Buffer
            ? (await simpleParser(source)).text ?? ''
            : '';
        matched = { ...env, body: text };
        break;
      }
      return matched;
    },
    async close() {
      await client.logout().catch(() => {});
    },
  };
};

/** Default SMTP sender backed by nodemailer (smtp.qq.com:465). */
const defaultSendMail: SendMailFn = async (creds, mail) => {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: creds.email, pass: creds.authCode },
  });
  await transporter.sendMail({
    from: creds.email,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.text,
  });
};

/** Local structural shape of the fields we read from an imapflow fetch message. */
interface QqFetchMessage {
  uid?: number;
  envelope?: {
    subject?: string;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
    date?: string;
  };
  source?: Buffer | string;
}

function envelopeFromFetch(msg: QqFetchMessage): QqMailEnvelope | null {
  const uid = msg.uid as number | undefined;
  if (typeof uid !== 'number' || !msg.envelope) return null;
  const env = msg.envelope;
  return {
    uid,
    subject: env.subject ?? '',
    from: addresses(env.from),
    to: addresses(env.to),
    date: env.date ?? '',
    snippet: env.subject ?? '',
  };
}

function addresses(list: { name?: string; address?: string }[] | undefined): string {
  if (!list) return '';
  return list
    .map((a) => (a.address?.trim() ? `${a.name ? `${a.name} ` : ''}${a.address}` : a.name ?? ''))
    .filter(Boolean)
    .join(', ');
}

function matches(env: QqMailEnvelope, needle: string): boolean {
  return (
    env.subject.toLowerCase().includes(needle) ||
    env.from.toLowerCase().includes(needle) ||
    env.snippet.toLowerCase().includes(needle)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function invalidArguments(message: string): ConnectorInvokeResult {
  return { success: false, error: { code: 'invalid_arguments', message, retriable: false } };
}

function providerError(message: string): ConnectorInvokeResult {
  return { success: false, error: { code: 'provider_error', message, retriable: false } };
}

/**
 * Construct the QQ Mail connector. Reads credentials from the vault and uses
 * IMAP/SMTP via injectable transports (defaults hit imap.qq.com / smtp.qq.com).
 * The `accessToken` argument of the base `ConnectorModule.invoke` is unused —
 * credentials come from the vault, not the OAuth token service.
 */
export function createQqMailConnector(
  vault: TokenVault,
  deps: { connectImap?: ConnectImapFn; sendMail?: SendMailFn } = {},
): ConnectorModule {
  const connectImap = deps.connectImap ?? defaultConnectImap;
  const sendMail = deps.sendMail ?? defaultSendMail;
  const loadCreds = () => credentialsFromVault(vault);
  const unlocked = (): ConnectorInvokeResult =>
    providerError('qq-mail is not connected — provide your email address and authorization code in Settings → Connections');

  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listQqMailDescriptors(connectionId);
    },
    async invoke(action: string, args: unknown, _accessToken: string): Promise<ConnectorInvokeResult> {
      const creds = loadCreds();
      if (!creds) return unlocked();
      try {
        if (action === Qq_SEARCH_ACTION) {
          const input = asRecord(args);
          const session = await connectImap(creds);
          try {
            const envelopes = await session.search(
              clampNumber(input.maxResults, 10, 1, 20),
              stringValue(input.query),
            );
            return { success: true, data: { messages: envelopes } };
          } finally {
            await session.close();
          }
        }
        if (action === Qq_READ_ACTION) {
          const uidRaw = asRecord(args).uid;
          if (typeof uidRaw !== 'number' || !Number.isInteger(uidRaw) || uidRaw <= 0) {
            return invalidArguments('uid must be a positive integer');
          }
          const session = await connectImap(creds);
          try {
            const message = await session.read(uidRaw);
            return message
              ? { success: true, data: message }
              : invalidArguments(`No QQ Mail message found for uid ${uidRaw}`);
          } finally {
            await session.close();
          }
        }
        if (action === Qq_SEND_ACTION) {
          const input = asRecord(args);
          const to = stringArray(input.to);
          const subject = stringValue(input.subject);
          const body = stringValue(input.body);
          if (to.length === 0) return invalidArguments('to must contain at least one recipient email address');
          if (!subject) return invalidArguments('subject is required');
          if (!body) return invalidArguments('body is required');
          await sendMail(creds, {
            to,
            cc: stringArray(input.cc),
            bcc: stringArray(input.bcc),
            subject,
            text: body,
          });
          return { success: true, data: { to, subject } };
        }
        return {
          success: false,
          error: { code: 'unknown_action', message: `Unknown qq-mail action: ${action}`, retriable: false },
        };
      } catch (err) {
        return providerError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}