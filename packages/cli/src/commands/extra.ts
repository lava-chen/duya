/**
 * packages/cli/src/commands/extra.ts
 *
 * Phase 4.3: message / mcp / skill / channel extras for `duya`.
 *
 *   message send <sessionId> <content>     — append a user message
 *   mcp test <name>                        — smoke-spawn the MCP server
 *   skill install <id> --from-path <dir>   — install a local skill
 *   skill uninstall <id>                   — remove an installed skill
 *   skill sync                             — re-sync bundled skills
 *   channel test <channelId>               — verify channel id shape
 *   channel send-test <channelId>          — record a test-send (Phase 4.3)
 */

import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import type { CliSubcommandContext, ExitCode } from '../program/registry.js';

function reportError(err: unknown): ExitCode {
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return (err.isAppUnavailable() ? 2 : 1) as ExitCode;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

function output(format: OutputFormat, json: unknown, text: string): void {
  process.stdout.write(format === 'json' ? renderJson(json) + '\n' : text + '\n');
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function requireYes(ctx: CliSubcommandContext, action: string): ExitCode | null {
  if (ctx.options.yes === true || process.stdin.isTTY) return null;
  process.stderr.write(`interactive_required: ${action} requires --yes in non-interactive mode\n`);
  return 3;
}

// message send
export async function runMessageSend(ctx: CliSubcommandContext): Promise<ExitCode> {
  const sessionId = ctx.args[0] ?? asString(ctx.options.sessionId);
  const content = ctx.args[1] ?? asString(ctx.options.content);
  if (!sessionId || !content) {
    process.stderr.write('usage: duya message send <sessionId> <content>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; id: string; sessionId: string }>(
      '/v1/messages/send',
      { sessionId, content },
    );
    output(ctx.format, body, `Sent message ${body.id} to session ${body.sessionId}.\n`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// mcp test
export async function runMCPTest(ctx: CliSubcommandContext): Promise<ExitCode> {
  const name = ctx.args[0];
  if (!name) {
    process.stderr.write('usage: duya mcp test <name>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{
      ok: boolean;
      reason: string;
      pid?: number;
      exitCode?: number | null;
      stdout: string;
      stderr: string;
    }>(`/v1/mcps/${encodeURIComponent(name)}/test`, {});
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`${body.ok ? 'OK' : 'FAIL'} ${name} (${body.reason})\n`);
      if (body.stdout) process.stdout.write(`  stdout: ${body.stdout}\n`);
      if (body.stderr) process.stdout.write(`  stderr: ${body.stderr}\n`);
    }
    return body.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

// skill install / uninstall / sync
export async function runSkillInstall(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = requireYes(ctx, 'skill install');
  if (guard !== null) return guard;
  const id = ctx.args[0];
  const fromPath = asString(ctx.options.fromPath);
  if (!fromPath) {
    process.stderr.write('usage: duya skill install [<id>] --from-path <dir>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; id: string; path: string }>(
      '/v1/skills/install',
      { fromPath, id },
    );
    output(ctx.format, body, `Installed skill ${body.id} → ${body.path}\n`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runSkillUninstall(ctx: CliSubcommandContext): Promise<ExitCode> {
  const guard = requireYes(ctx, 'skill uninstall');
  if (guard !== null) return guard;
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('usage: duya skill uninstall <id>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; id: string }>(
      `/v1/skills/${encodeURIComponent(id)}/uninstall`,
      {},
    );
    output(ctx.format, body, `Uninstalled skill ${body.id}.\n`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

export async function runSkillSync(ctx: CliSubcommandContext): Promise<ExitCode> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; added: string[]; updated: string[] }>(
      '/v1/skills/sync',
      {},
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(
        `Synced bundled skills. added=${body.added.length} updated=${body.updated.length}\n`,
      );
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

// channel test / send-test
export async function runChannelTest(ctx: CliSubcommandContext): Promise<ExitCode> {
  const channelId = ctx.args[0] ?? asString(ctx.options.channelId);
  if (!channelId) {
    process.stderr.write('usage: duya channel test <channelId>\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; reason: string; channelId: string }>(
      '/v1/channels/test',
      { channelId },
    );
    output(ctx.format, body, `${body.ok ? 'OK' : 'FAIL'} ${body.channelId} (${body.reason})\n`);
    return body.ok ? 0 : 1;
  } catch (err) {
    return reportError(err);
  }
}

export async function runChannelSendTest(ctx: CliSubcommandContext): Promise<ExitCode> {
  const channelId = ctx.args[0] ?? asString(ctx.options.channelId);
  const text = asString(ctx.options.text) ?? 'ping from duya cli';
  if (!channelId) {
    process.stderr.write('usage: duya channel send-test <channelId> [--text <text>]\n');
    return 64;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<{ ok: boolean; sent: boolean; reason: string }>(
      '/v1/channels/send-test',
      { channelId, text },
    );
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(
        body.ok
          ? `Recorded test-send for ${channelId} (sent=${body.sent}, reason=${body.reason})\n`
          : `Failed: ${body.reason}\n`,
      );
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}
