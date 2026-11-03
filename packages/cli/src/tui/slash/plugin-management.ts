import path from 'node:path';
import { parseMarketplaceSource } from '@duya/plugin-core/marketplace/source-parse';
import { resolveLocalPluginPath } from '../../api/plugin-path.js';
import type { TuiSlashContext } from './types.js';
import { showPanel, describeError } from './shared.js';

/** Terminal interaction only; installation and configuration remain owned by Host. */
async function localPath(ctx: TuiSlashContext, source: string): Promise<string> {
  if (path.isAbsolute(source) || source.startsWith('~')) return resolveLocalPluginPath(source, process.cwd());
  const session = await ctx.client.readLocalSession(ctx.session.id, { includeAllSessions: true });
  if (!session?.workingDirectory) throw new Error('This Host cannot resolve relative plugin paths; provide an absolute directory');
  return resolveLocalPluginPath(source, session.workingDirectory);
}
const panelOptions = { footer: 'Esc · close', scrollable: true };
export async function runPluginManagement(ctx: TuiSlashContext, args: string): Promise<boolean> {
  const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  if (!match || match[1] === 'list') return false;
  const action = match[1];
  const value = match[2]?.trim() ?? '';
  try {
    if (action === 'discover') {
      const { entries } = await ctx.client.listPluginCatalog();
      showPanel(ctx, 'Plugin catalog', entries.map(plugin => `${plugin.pluginId}@${plugin.marketplace}  ${plugin.version}  ${plugin.installed ? 'installed' : 'available'}`), panelOptions);
      return true;
    }
    if (action === 'marketplace' && (!value || value === 'list')) {
      const { marketplaces } = await ctx.client.listPluginMarketplaces();
      showPanel(ctx, 'Plugin marketplaces', marketplaces.map(market => `${market.name}  ${market.kind}  ${market.pluginCount} plugins${market.error ? ' · unavailable' : ''}`), panelOptions);
      return true;
    }
    if (!['install', 'install-path', 'enable', 'disable', 'uninstall', 'update', 'marketplace'].includes(action ?? '')) {
      showPanel(ctx, 'Plugins', ['Usage: /plugin [list|discover|install <id>|install-path <directory>|enable <id>|disable <id>|update <id>|uninstall <id>]', '/plugin marketplace [list|add <source>|remove <name>|refresh <name>]'], panelOptions);
      return true;
    }
    if (ctx.busy) throw new Error('Wait for the current turn to finish before changing plugins');
    if (!value) throw new Error('Provide a plugin id, directory or marketplace source');
    if (!ctx.tui.choose) throw new Error('This terminal cannot confirm a plugin change');
    const confirmed = await ctx.tui.choose(`Confirm plugin ${action}: ${value}`, [{ label: 'Cancel', value: 'cancel' }, { label: 'Confirm', value: 'confirm' }]);
    if (confirmed !== 'confirm') return true;
    if (action === 'marketplace') {
      const market = value.match(/^(add|remove|refresh)\s+([\s\S]+)$/u);
      if (!market?.[2]) throw new Error('Use marketplace add <source>, remove <name> or refresh <name>');
      if (market[1] === 'add') {
        const parsed = parseMarketplaceSource(market[2]);
        await ctx.client.addPluginMarketplace(parsed.kind === 'local' ? await localPath(ctx, parsed.path!) : market[2]);
      }
      else if (market[1] === 'remove') await ctx.client.removePluginMarketplace(market[2]);
      else await ctx.client.refreshPluginMarketplace(market[2]);
    } else if (action === 'install-path') await ctx.client.installPluginLegacy({ fromPath: await localPath(ctx, value) });
    else if (action === 'install') {
      const at = value.lastIndexOf('@');
      await ctx.client.installPluginLegacy(at > 0 ? { pluginId: value.slice(0, at), marketplace: value.slice(at + 1) } : { pluginId: value });
    } else if (action === 'enable' || action === 'disable') await ctx.client.setPluginEnabledLegacy(value, action === 'enable');
    else if (action === 'uninstall') await ctx.client.uninstallPlugin(value);
    else await ctx.client.updatePlugin(value);
    showPanel(ctx, 'Plugins', ['Plugin configuration updated.', 'Reload or start a new session to apply the change.'], panelOptions);
  } catch (error) { ctx.tui.printError(describeError(error)); }
  return true;
}
