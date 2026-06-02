/**
 * packages/agent/src/cli/commands/plugin.ts
 *
 * `duya plugin list`   — list installed plugins (5 fields)
 * `duya plugin info <name>` — show 7-field detail for one plugin
 */

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

function formatBool(b: boolean): string {
  return b ? 'yes' : 'no';
}

function renderListText(plugins: PluginListItem[]): string {
  if (plugins.length === 0) return 'No plugins installed.';
  const header = `${'ID'.padEnd(34)} ${'NAME'.padEnd(20)} ${'VERSION'.padEnd(10)} ${'ENABLED'.padEnd(7)} ${'CAPABILITIES'.padEnd(20)} SOURCE`;
  const sep = '-'.repeat(header.length);
  const rows = plugins.map((p) => {
    const caps = p.capabilities.length > 0 ? p.capabilities.join(',') : '-';
    return `${p.id.padEnd(34)} ${p.name.padEnd(20)} ${p.version.padEnd(10)} ${formatBool(p.enabled).padEnd(7)} ${caps.padEnd(20)} ${p.source}`;
  });
  return [header, sep, ...rows].join('\n');
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

async function listPlugins(format: OutputFormat): Promise<number> {
  try {
    const client = await CliApiClient.connect();
    const body = await client.get<{ plugins: PluginListItem[] }>('/v1/plugins');
    process.stdout.write(
      format === 'json' ? renderJson(body) + '\n' : renderListText(body.plugins) + '\n',
    );
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
};
