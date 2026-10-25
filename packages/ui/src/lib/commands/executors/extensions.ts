/**
 * Extension-surface executors: apps / plugin.
 *
 * Both commands open the extensions page, which has two tabs: the marketplace
 * (plugins to install) and the installed list (plugins, app connections, MCP
 * servers and skills).
 *
 * The tab is component state inside `ExtensionsPage`, so a command cannot
 * pre-select it from here. `/plugin` lands on the marketplace because that is
 * the tab the page opens on; `/apps` opens the page and names the section in
 * its toast — the same answer `/mcp` gives for the MCP servers that live in
 * that same tab.
 *
 * The capability check is the other half of the job: a surface with no
 * extensions (the Web app) says so instead of opening a page that renders
 * nothing.
 */

import type { CommandExecutorFn } from './registry';
import type { CommandResult } from '../types';
import { useConversationStore } from '@/stores/conversation-store';
import { peekUiServices } from '@/services';

/** Uniform guard for the paths that need the live composer. */
function bridgeMissing(name: string): CommandResult {
  return { type: 'error', message: `/${name}: app bridge unavailable` };
}

export const EXTENSION_EXECUTORS: Record<string, CommandExecutorFn> = {
  /**
   * `/apps` → the installed app connections (slack / google / microsoft365 /
   * wecom / qq-mail / remote-mcp).
   *
   * Not the plugin mini-apps: those are the UI surfaces a plugin declares
   * (`components/plugin-apps/`). "Apps" here means the connectors the user
   * connects their accounts to.
   */
  apps: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('apps');
    if (peekUiServices()?.capabilities.extensions === false) {
      return { type: 'error', message: '当前平台不支持应用连接器。' };
    }
    // Best-effort intent: the extensions page keeps its tab in component
    // state, so the page is told which tab to open. A page that does not
    // listen yet still opens — the toast then names the section.
    window.dispatchEvent(new CustomEvent('duya:open-extensions-tab', { detail: { tab: 'installed' } }));
    useConversationStore.getState().setCurrentView('extensions');
    app.toast('应用连接在扩展页的「已安装」标签下', 'info');
    return { type: 'dismiss' };
  },

  /** `/plugin` → the plugin marketplace (install / update plugins). */
  plugin: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('plugin');
    if (peekUiServices()?.capabilities.extensions === false) {
      return { type: 'error', message: '当前平台不支持插件市场。' };
    }
    useConversationStore.getState().setCurrentView('extensions');
    app.toast('已打开插件市场', 'info');
    return { type: 'dismiss' };
  },
};
