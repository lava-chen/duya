/**
 * packages/agent/src/cli/commands/channel.ts
 *
 * `duya channel` — gateway IM channel control plane + per-bot bindings.
 *
 * Read surface:
 *   list       — discovered channels (id / platform / name / guild / type / bound)
 *   info       — single channel + binding details
 *   platforms  — configured IM platforms (telegram / qq / feishu)
 *   status     — ChannelStatus snapshot (connected / lastError / streaming)
 *   bindings   — per-bot channel bindings (agents/<id>/channels/, plan 488)
 *
 * Write surface (488 P2.3):
 *   send       — push a message to a channel via the gateway
 *   connect    — bind a platform to a bot (credential via env/stdin only)
 *   disconnect — unbind a platform (optionally agent-scoped)
 *
 * Data source: `electron/cli/handlers/channels.ts` → `GET /v1/channels`,
 * `GET /v1/channels/:id`, `GET /v1/platforms`, `GET /v1/platforms/:p/status`.
 *
 * DTOs frozen in `docs/design-docs/cli-control-plane/roadmap.md §3.4`.
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

// ---------------------------------------------------------------------------
// DTOs (frozen v1.0.0)
// ---------------------------------------------------------------------------

export interface ChannelListItemDTO {
  id: string;
  platform: string;
  name: string;
  guild?: string;
  type: string;
  source: 'directory' | 'binding';
  bound: boolean;
  lastActivityAt?: number;
}

export interface ChannelInfoItemDTO extends ChannelListItemDTO {
  duyaSessionId?: string;
  sdkSessionId?: string;
  workingDirectory?: string;
  model?: string;
}

export interface PlatformItemDTO {
  platform: string;
  enabled: boolean;
  connected: boolean;
  totalMessages: number;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
}

export interface PlatformStatusItemDTO extends PlatformItemDTO {
  running: boolean;
  streaming: boolean | null;
  toolProgress: 'all' | 'new' | 'off';
  showReasoning: boolean;
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

function renderListText(channels: ChannelListItemDTO[]): string {
  if (channels.length === 0) return '(no channels discovered)';
  const idWidth = Math.max(2, ...channels.map((c) => c.id.length));
  const platformWidth = Math.max(8, ...channels.map((c) => c.platform.length));
  const nameWidth = Math.max(4, ...channels.map((c) => c.name.length));
  const sourceWidth = Math.max(6, ...channels.map((c) => c.source.length));
  const header = [
    'ID'.padEnd(idWidth),
    'PLATFORM'.padEnd(platformWidth),
    'NAME'.padEnd(nameWidth),
    'SOURCE'.padEnd(sourceWidth),
    'GUILD'.padEnd(0),
    'TYPE'.padEnd(0),
    'BOUND',
    'LAST ACTIVITY',
  ].join('  ');
  const sep = '-'.repeat(header.length);
  const rows = channels.map((c) =>
    [
      c.id.padEnd(idWidth),
      c.platform.padEnd(platformWidth),
      c.name.padEnd(nameWidth),
      c.source.padEnd(sourceWidth),
      c.guild ?? '-',
      c.type,
      c.bound ? 'yes' : 'no',
      c.lastActivityAt ? new Date(c.lastActivityAt).toISOString() : '-',
    ].join('  '),
  );
  return [header, sep, ...rows].join('\n');
}

function renderInfoText(c: ChannelInfoItemDTO): string {
  const lines = [
    `${c.id}`,
    `  platform:   ${c.platform}`,
    `  name:       ${c.name}`,
    `  guild:      ${c.guild ?? '-'}`,
    `  type:       ${c.type}`,
    `  source:     ${c.source}`,
    `  bound:      ${c.bound ? 'yes' : 'no'}`,
  ];
  if (c.lastActivityAt) {
    lines.push(`  lastActivityAt: ${new Date(c.lastActivityAt).toISOString()}`);
  }
  if (c.bound) {
    lines.push(`  duyaSession: ${c.duyaSessionId ?? '-'}`);
    if (c.sdkSessionId) lines.push(`  sdkSession:  ${c.sdkSessionId}`);
    if (c.workingDirectory) lines.push(`  workingDir: ${c.workingDirectory}`);
    if (c.model) lines.push(`  model:       ${c.model}`);
  }
  return lines.join('\n');
}

function renderPlatformsText(platforms: PlatformItemDTO[]): string {
  if (platforms.length === 0) return '(no platforms configured)';
  const lines: string[] = [];
  lines.push(`${platforms.length} platform${platforms.length !== 1 ? 's' : ''} configured`);
  for (const p of platforms) {
    const status = p.connected ? 'connected' : p.enabled ? 'disconnected' : 'disabled';
    const lastConn = p.lastConnectedAt
      ? ` (last: ${new Date(p.lastConnectedAt).toISOString()})`
      : '';
    lines.push(`  ${p.platform.padEnd(12)} ${status.padEnd(14)} msgs=${p.totalMessages}${lastConn}`);
    if (p.lastError) {
      lines.push(`              last error: ${p.lastError}`);
    }
  }
  return lines.join('\n');
}

function renderStatusText(p: PlatformStatusItemDTO): string {
  const lines = [
    `${p.platform}`,
    `  enabled:        ${p.enabled ? 'yes' : 'no'}`,
    `  running:        ${p.running ? 'yes' : 'no'}`,
    `  connected:      ${p.connected ? 'yes' : 'no'}`,
    `  totalMessages:  ${p.totalMessages}`,
    `  streaming:      ${p.streaming === null ? 'n/a' : p.streaming ? 'yes' : 'no'}`,
    `  toolProgress:   ${p.toolProgress}`,
    `  showReasoning:  ${p.showReasoning ? 'yes' : 'no'}`,
  ];
  if (p.lastConnectedAt) {
    lines.push(`  lastConnectedAt: ${new Date(p.lastConnectedAt).toISOString()}`);
  }
  if (p.lastErrorAt) {
    lines.push(`  lastErrorAt:    ${new Date(p.lastErrorAt).toISOString()}`);
    if (p.lastError) lines.push(`  lastError:      ${p.lastError}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTTP fetch helpers
// ---------------------------------------------------------------------------

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

async function listChannels(
  format: OutputFormat,
  platform?: string,
): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const path = platform
      ? `/v1/channels?platform=${encodeURIComponent(platform)}`
      : '/v1/channels';
    const body = await client.get<{ channels: ChannelListItemDTO[] }>(path);
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderListText(body.channels) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function infoChannel(id: string, format: OutputFormat): Promise<ExitCode> {
  if (!id) {
    process.stderr.write('Usage: duya channel info <id>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<ChannelInfoItemDTO>(
      `/v1/channels/${encodeURIComponent(id)}`,
    );
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderInfoText(body) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function listPlatforms(format: OutputFormat): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ platforms: PlatformItemDTO[] }>('/v1/platforms');
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderPlatformsText(body.platforms) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function platformStatus(
  format: OutputFormat,
  platform?: string,
): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    if (platform) {
      const body = await client.get<PlatformStatusItemDTO>(
        `/v1/platforms/${encodeURIComponent(platform)}/status`,
      );
      process.stdout.write(
        format === 'json' ? renderJson(body) + '\n' : renderStatusText(body) + '\n',
      );
      return 0;
    }
    const body = await client.get<{ statuses: PlatformStatusItemDTO[] }>(
      '/v1/platforms/status',
    );
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      for (const p of body.statuses) {
        process.stdout.write(renderStatusText(p) + '\n\n');
      }
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export interface ChannelSendResultDTO {
  ok: boolean;
  platform: string;
  platformChatId: string;
  platformMsgId?: string;
  error?: string;
}

async function sendChannel(
  format: OutputFormat,
  channelId: string,
  text: string,
  platform?: string,
  chatId?: string,
  filePath?: string,
): Promise<ExitCode> {
  if (!text && !filePath) {
    process.stderr.write('usage: duya channel send <channelId> <text> [--file <path>] [--platform <p> --chat <id>]\n');
    return 64;
  }
  const body: Record<string, unknown> = { text };
  if (filePath) body.filePath = filePath;
  if (platform && chatId) {
    body.platform = platform;
    body.chatId = chatId;
  } else if (channelId) {
    body.channelId = channelId;
  } else {
    process.stderr.write('usage: duya channel send <channelId> <text>, or --platform <p> --chat <id> <text>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<ChannelSendResultDTO>('/v1/channels/send', body);
    if (format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else if (result.ok) {
      process.stdout.write(
        `Sent to ${result.platform}:${result.platformChatId}` +
          (result.platformMsgId ? ` (msg_id=${result.platformMsgId})` : '') +
          '\n',
      );
    } else {
      process.stderr.write(
        `Send failed: ${result.error ?? 'unknown error'}\n`,
      );
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

// 488 P2.3: channel connect/disconnect operations
export interface ChannelDisconnectResultDTO {
  ok: boolean;
  platform: string;
  error?: string;
}

/** Per-bot channel binding (plan 488 — agent-scoped channel store). */
export interface AgentChannelBindingDTO {
  platform: string;
  label: string;
  status: 'configured';
  displayName: string;
}

export interface AgentChannelListResultDTO {
  agentId: string;
  channels: AgentChannelBindingDTO[];
}

export interface AgentChannelConnectResultDTO {
  ok: boolean;
  agentId: string;
  platform: string;
  label?: string;
  error?: string;
}

function renderBindingsText(result: AgentChannelListResultDTO): string {
  const channels = result.channels;
  if (channels.length === 0) return `(no channels bound to agent ${result.agentId})`;
  const lines = [`${result.agentId}: ${channels.length} channel${channels.length !== 1 ? 's' : ''} bound`];
  for (const c of channels) {
    lines.push(`  ${c.platform.padEnd(12)} ${c.label}  (${c.status})`);
  }
  return lines.join('\n');
}

async function listAgentChannels(
  format: OutputFormat,
  agentId: string,
): Promise<ExitCode> {
  if (!agentId) {
    process.stderr.write('usage: duya channel bindings --agent <agentId>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.get<AgentChannelListResultDTO>(
      `/v1/agents/${encodeURIComponent(agentId)}/channels`,
    );
    process.stdout.write(
      format === 'json' ? renderJson(result) + '\n' : renderBindingsText(result) + '\n',
    );
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

/**
 * Read the channel credential from the environment or stdin.
 * Credentials are never accepted as command-line arguments (argv leaks via
 * process listings and shell history).
 */
async function readCredential(tokenEnv?: string, fromStdin?: boolean): Promise<string> {
  if (fromStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
  }
  const envName = tokenEnv || 'DUYA_CHANNEL_TOKEN';
  return (process.env[envName] ?? '').trim();
}

async function connectAgentChannel(
  format: OutputFormat,
  agentId: string,
  platform: string,
  label?: string,
  tokenEnv?: string,
  fromStdin?: boolean,
): Promise<ExitCode> {
  if (!agentId || !platform) {
    process.stderr.write(
      'usage: duya channel connect --agent <agentId> --platform <p> [--label <label>] [--token-env <VAR> | --stdin]\n' +
        'credential source: DUYA_CHANNEL_TOKEN env var (default), --token-env <VAR>, or --stdin\n',
    );
    return 64;
  }
  let credential = '';
  try {
    credential = await readCredential(tokenEnv, fromStdin);
  } catch (err) {
    process.stderr.write(`Failed to read credential: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!credential) {
    process.stderr.write(
      'No credential provided. Set DUYA_CHANNEL_TOKEN (or --token-env <VAR> / --stdin); never pass tokens as CLI args.\n',
    );
    return 1;
  }
  try {
    const client = await CliApiClient.connect();
    const result = await client.post<AgentChannelConnectResultDTO>(
      `/v1/agents/${encodeURIComponent(agentId)}/channels/connect`,
      { platform, credential, ...(label ? { label } : {}) },
    );
    if (format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else if (result.ok) {
      process.stdout.write(`Connected ${result.platform} to agent ${result.agentId} (label: ${result.label ?? '-'})\n`);
    } else {
      process.stderr.write(`Connect failed: ${result.error ?? 'unknown error'}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

async function disconnectChannel(
  format: OutputFormat,
  platform: string,
  agentId?: string,
): Promise<ExitCode> {
  if (!platform) {
    process.stderr.write('usage: duya channel disconnect --platform <platform> [--agent <agentId>]\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    if (agentId) {
      const result = await client.post<AgentChannelConnectResultDTO>(
        `/v1/agents/${encodeURIComponent(agentId)}/channels/disconnect`,
        { platform },
      );
      if (format === 'json') {
        process.stdout.write(renderJson(result) + '\n');
      } else if (result.ok) {
        process.stdout.write(`Disconnected ${result.platform} from agent ${result.agentId}\n`);
      } else {
        process.stderr.write(`Disconnect failed: ${result.error ?? 'unknown error'}\n`);
      }
      return result.ok ? 0 : 1;
    }
    const result = await client.post<ChannelDisconnectResultDTO>('/v1/channels/disconnect', {
      platform,
    });
    if (format === 'json') {
      process.stdout.write(renderJson(result) + '\n');
    } else if (result.ok) {
      process.stdout.write(`Disconnected ${result.platform}\n`);
    } else {
      process.stderr.write(`Disconnect failed: ${result.error ?? 'unknown error'}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Public surface (consumed by descriptors.ts)
// ---------------------------------------------------------------------------

export const runChannelCommand = {
  list: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    const platform =
      typeof ctx.options.platform === 'string' ? ctx.options.platform : undefined;
    return listChannels(ctx.format, platform);
  },
  info: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    return infoChannel(ctx.args[0] ?? '', ctx.format);
  },
  platforms: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    return listPlatforms(ctx.format);
  },
  status: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    const platform =
      typeof ctx.options.platform === 'string' ? ctx.options.platform : undefined;
    return platformStatus(ctx.format, platform);
  },
  send: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    const platform =
      typeof ctx.options.platform === 'string' ? ctx.options.platform : undefined;
    const chatId =
      typeof ctx.options.chat === 'string' ? ctx.options.chat : undefined;
    const filePath =
      typeof ctx.options.file === 'string' ? ctx.options.file : undefined;
    // Positional form: `channel send <channelId> <text>`.
    let channelId = ctx.args[0] ?? '';
    let text = ctx.args[1] ?? '';
    // Flag form: `channel send --platform <p> --chat <id> <text>` (or --text).
    if (platform && chatId) {
      if (!text) text = ctx.args[0] ?? '';
      channelId = '';
    }
    if (!text) text = typeof ctx.options.text === 'string' ? ctx.options.text : '';
    return sendChannel(ctx.format, channelId, text, platform, chatId, filePath);
  },
  // 488 P2.3: channel disconnect
  disconnect: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    const platform =
      typeof ctx.options.platform === 'string' ? ctx.options.platform : undefined;
    const agentId =
      typeof ctx.options.agent === 'string' ? ctx.options.agent : undefined;
    return disconnectChannel(ctx.format, platform ?? '', agentId);
  },
  // 488 P2.3: per-bot channel bindings (list/connect)
  bindings: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    const agentId =
      typeof ctx.options.agent === 'string' ? ctx.options.agent : undefined;
    return listAgentChannels(ctx.format, agentId ?? '');
  },
  connect: (ctx: CliSubcommandContext): Promise<ExitCode> => {
    const agentId =
      typeof ctx.options.agent === 'string' ? ctx.options.agent : undefined;
    const platform =
      typeof ctx.options.platform === 'string' ? ctx.options.platform : undefined;
    const label =
      typeof ctx.options.label === 'string' ? ctx.options.label : undefined;
    const tokenEnv =
      typeof ctx.options['token-env'] === 'string' ? ctx.options['token-env'] : undefined;
    const fromStdin = ctx.options.stdin === true;
    return connectAgentChannel(ctx.format, agentId ?? '', platform ?? '', label, tokenEnv, fromStdin);
  },
};
