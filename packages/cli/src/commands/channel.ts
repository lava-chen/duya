/**
 * packages/agent/src/cli/commands/channel.ts
 *
 * `duya channel` — gateway IM channel control plane.
 *
 * Read-only surface:
 *   list       — discovered channels (id / platform / name / guild / type / bound)
 *   info       — single channel + binding details
 *   platforms  — configured IM platforms (telegram / qq / feishu)
 *   status     — ChannelStatus snapshot (connected / lastError / streaming)
 *
 * No write ops. Channel management is the gateway's responsibility —
 * see `electron/gateway/channel-directory.ts` and the gateway's
 * `bridge:platform_state` event flow.
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
};
