/**
 * packages/agent/src/cli/commands/plugin.ts
 *
 * `duya plugin list`   — list installed plugins (5 fields + filters)
 * `duya plugin info <id>` — show 7-field detail for one plugin
 * `duya plugin enable <id>` / `duya plugin disable <id>` — Phase 7 write ops
 * `duya plugin doctor` — plugin load / manifest / registry diagnostics
 */

import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { CliApiClient } from '../api/client.js';
import { CliApiError } from '../api/errors.js';
import { renderJson, type OutputFormat } from '../api/format.js';
import { CliUserDataMissingError } from '../api/runtime-config.js';

interface PluginListItem {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  capabilities: string[];
  source: string;
}

interface PluginInfoItem extends PluginListItem {
  description: string;
  permissions: string[];
}

interface PluginWriteResult {
  id: string;
  enabled: boolean;
  changedAt: string;
}

interface PluginDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  pluginId?: string;
}

interface PluginDoctorResponse {
  checks: PluginDoctorCheck[];
}

function formatBool(b: boolean): string {
  return b ? 'yes' : 'no';
}

const LIST_TSV_HEADER = 'id\tname\tversion\tenabled\tcapabilities\tsource';

export function renderListTsv(plugins: PluginListItem[]): string {
  const rows = plugins.map((p) => {
    const caps = p.capabilities.join(',');
    return `${p.id}\t${p.name}\t${p.version}\t${formatBool(p.enabled)}\t${caps}\t${p.source}`;
  });
  return [LIST_TSV_HEADER, ...rows].join('\n');
}

export function renderListText(plugins: PluginListItem[]): string {
  if (plugins.length === 0) return 'No plugins installed.';
  const header = `${'ID'.padEnd(34)} ${'NAME'.padEnd(20)} ${'VERSION'.padEnd(10)} ${'ENABLED'.padEnd(7)} ${'CAPABILITIES'.padEnd(20)} SOURCE`;
  const sep = '-'.repeat(header.length);
  const rows = plugins.map((p) => {
    const caps = p.capabilities.length > 0 ? p.capabilities.join(',') : '-';
    return `${p.id.padEnd(34)} ${p.name.padEnd(20)} ${p.version.padEnd(10)} ${formatBool(p.enabled).padEnd(7)} ${caps.padEnd(20)} ${p.source}`;
  });
  return [header, sep, ...rows].join('\n');
}

export function renderListVerbose(plugins: PluginListItem[]): string {
  if (plugins.length === 0) return 'No plugins installed.';
  const blocks = plugins.map((p) => {
    const caps = p.capabilities.length > 0 ? p.capabilities.join(', ') : '-';
    return [
      `${p.id}  (${p.name})`,
      `  version:      ${p.version}`,
      `  source:       ${p.source}`,
      `  enabled:      ${formatBool(p.enabled)}`,
      `  capabilities: ${caps}`,
    ].join('\n');
  });
  return blocks.join('\n\n');
}

function renderInfoText(p: PluginInfoItem): string {
  const lines = [
    `${p.id}  (${p.name})`,
    `  version:      ${p.version}`,
    `  source:       ${p.source}`,
    `  enabled:      ${formatBool(p.enabled)}`,
    `  capabilities: ${p.capabilities.length > 0 ? p.capabilities.join(', ') : '-'}`,
    `  permissions:  ${p.permissions.length > 0 ? p.permissions.join(', ') : '-'}`,
    `  description:  ${p.description || '-'}`,
  ];
  return lines.join('\n');
}

function renderDoctorText(payload: PluginDoctorResponse): string {
  if (payload.checks.length === 0) return 'No plugin issues detected.';
  const lines: string[] = [];
  const idWidth = Math.max(...payload.checks.map((c) => c.id.length), 4);
  const statusWidth = Math.max(...payload.checks.map((c) => c.status.length), 4);
  const header = `${'STATUS'.padEnd(statusWidth)} ${'CHECK_ID'.padEnd(idWidth)} MESSAGE`;
  lines.push(header);
  for (const c of payload.checks) {
    const tag = c.pluginId ? ` (${c.pluginId})` : '';
    lines.push(`${c.status.padEnd(statusWidth)} ${c.id.padEnd(idWidth)} ${c.message}${tag}`);
  }
  return lines.join('\n');
}

function isInteractive(): boolean {
  return Boolean(stdin.isTTY);
}

async function promptConfirm(message: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === 'y' || v === 'yes');
    });
  });
}

async function listPlugins(opts: {
  enabled?: boolean;
  verbose?: boolean;
  format: OutputFormat;
}): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ plugins: PluginListItem[] }>('/v1/plugins');
    const filtered = opts.enabled ? body.plugins.filter((p) => p.enabled) : body.plugins;

    if (opts.format === 'json') {
      process.stdout.write(renderJson({ plugins: filtered }) + '\n');
    } else if (opts.format === 'tsv') {
      process.stdout.write(renderListTsv(filtered) + '\n');
    } else if (opts.verbose) {
      process.stdout.write(renderListVerbose(filtered) + '\n');
    } else {
      process.stdout.write(renderListText(filtered) + '\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function infoPlugin(id: string, format: OutputFormat): Promise<number> {
  if (!id || id.trim().length === 0) {
    process.stderr.write('Usage: duya plugin info <id>\n');
    return 1;
  }
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<PluginInfoItem>(
      '/v1/plugins/' + encodeURIComponent(id),
    );
    process.stdout.write(format === 'json' ? renderJson(body) + '\n' : renderInfoText(body) + '\n');
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function runPluginWrite(
  id: string,
  action: 'enable' | 'disable',
  yes: boolean,
  format: OutputFormat,
): Promise<number> {
  if (!id || id.trim().length === 0) {
    process.stderr.write(`Usage: duya plugin ${action} <id>\n`);
    return 1;
  }
  if (!yes && !isInteractive()) {
    process.stderr.write(
      'interactive_required: write operation requires --yes in non-interactive mode\n',
    );
    return 3;
  }
  if (!yes) {
    const confirmed = await promptConfirm(`Confirm ${action} plugin '${id}'?`);
    if (!confirmed) {
      process.stderr.write(`aborted: ${action} of '${id}' cancelled\n`);
      return 1;
    }
  }

  const correlationId = randomUUID();
  const client = await CliApiClient.connect();
  try {
    const body = await client.post<{ plugin: PluginWriteResult }>(
      `/v1/plugins/${encodeURIComponent(id)}/${action}`,
      {},
      { correlationId },
    );
    if (format === 'json') {
      process.stdout.write(renderJson({ plugin: body.plugin, correlationId }) + '\n');
    } else {
      const state = body.plugin.enabled ? 'enabled' : 'disabled';
      process.stdout.write(`${state} plugin '${id}' at ${body.plugin.changedAt} (correlationId=${correlationId})\n`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function enablePlugin(id: string, yes: boolean, format: OutputFormat): Promise<number> {
  return runPluginWrite(id, 'enable', yes, format);
}

async function disablePlugin(id: string, yes: boolean, format: OutputFormat): Promise<number> {
  return runPluginWrite(id, 'disable', yes, format);
}

async function doctorPlugins(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<PluginDoctorResponse>('/v1/plugins/doctor');
    if (format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(renderDoctorText(body) + '\n');
    }
    const hasError = body.checks.some((c) => c.status === 'error');
    return hasError ? 1 : 0;
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  if (err instanceof CliUserDataMissingError) {
    process.stderr.write(err.message + '\n');
    return 2;
  }
  if (err instanceof CliApiError) {
    process.stderr.write(err.hint + '\n');
    return err.isAppUnavailable() ? 2 : 1;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

export const runPluginCommand = {
  list: listPlugins,
  info: infoPlugin,
  enable: enablePlugin,
  disable: disablePlugin,
  doctor: doctorPlugins,
  install: installPlugin,
  uninstall: uninstallPlugin,
  update: updatePlugin,
};

interface PluginWriteOk {
  plugin?: PluginInfoItem;
  id?: string;
  removed?: boolean;
}

async function installPlugin(ctx: { options: { yes?: boolean; fromPath?: string; scope?: string }; format: OutputFormat }): Promise<number> {
  if (ctx.options.yes !== true && !isInteractive()) {
    process.stderr.write('interactive_required: plugin install requires --yes in non-interactive mode\n');
    return 3;
  }
  const pluginId = (ctx as unknown as { args: string[] }).args[0];
  const fromPath = typeof ctx.options.fromPath === 'string' ? ctx.options.fromPath : undefined;
  if (!pluginId && !fromPath) {
    process.stderr.write('usage: duya plugin install <id> [--from-path <dir>] [--scope user|system]\n');
    return 64;
  }
  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<PluginWriteOk>('/v1/plugins/install', {
      pluginId,
      fromPath,
      scope: ctx.options.scope,
    }, { correlationId });
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else if (body.plugin) {
      process.stdout.write(`Installed ${body.plugin.id} (${body.plugin.name}) v${body.plugin.version}\n`);
    } else {
      process.stdout.write('Installed.\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function uninstallPlugin(ctx: { options: { yes?: boolean; deleteData?: boolean }; args: string[]; format: OutputFormat }): Promise<number> {
  if (ctx.options.yes !== true && !isInteractive()) {
    process.stderr.write('interactive_required: plugin uninstall requires --yes in non-interactive mode\n');
    return 3;
  }
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('usage: duya plugin uninstall <id> [--delete-data]\n');
    return 64;
  }
  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<PluginWriteOk>(`/v1/plugins/${encodeURIComponent(id)}/uninstall`, {
      deleteData: ctx.options.deleteData === true,
    }, { correlationId });
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else {
      process.stdout.write(`Uninstalled ${id}.\n`);
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function updatePlugin(ctx: { args: string[]; format: OutputFormat }): Promise<number> {
  const id = ctx.args[0];
  if (!id) {
    process.stderr.write('usage: duya plugin update <id>\n');
    return 64;
  }
  const correlationId = randomUUID();
  try {
    const client = await CliApiClient.connect();
    const body = await client.post<PluginWriteOk>(`/v1/plugins/${encodeURIComponent(id)}/update`, {}, { correlationId });
    if (ctx.format === 'json') {
      process.stdout.write(renderJson(body) + '\n');
    } else if (body.plugin) {
      process.stdout.write(`Updated ${body.plugin.id} → v${body.plugin.version}\n`);
    } else {
      process.stdout.write('Updated.\n');
    }
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

