/**
 * Auth executors: login / logout / permission(s).
 *
 * duya has no global account session — credentials live per provider in the
 * SQLite config, so "login" and "logout" are both provider-settings
 * operations rather than distinct states. Both commands therefore open the
 * provider settings page and tell the user what to do there.
 *
 * Permission mode IS a real session-level switch (ask / auto / bypass), so
 * `/permission <mode>` goes straight through the bridge.
 */

import type { CommandExecutorFn } from './registry';
import { useConversationStore } from '@/stores/conversation-store';

/** Human labels for the three composer permission modes. */
const PERMISSION_LABELS: Record<'ask' | 'auto' | 'bypass', string> = {
  ask: 'ask（询问：每次需要授权的操作都弹窗确认）',
  auto: 'auto（自动：由权限代理自动审查并在必要时拦截）',
  bypass: 'bypass（放行：自动接受所有操作，等同完全访问）',
};

const PERMISSION_MODES = ['ask', 'auto', 'bypass'] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Open the provider settings page.
 *
 * `openPanel('settings-providers')` dispatches the panel-intent event, and
 * the conversation store switch is the same navigation the composer's
 * "管理服务商" row performs — both are issued so the page opens today and
 * stays correct once the panel event has its own listener.
 */
function openProviderSettings(): void {
  const store = useConversationStore.getState();
  store.setSettingsTab('providers');
  store.setCurrentView('settings');
}

export const AUTH_EXECUTORS: Record<string, CommandExecutorFn> = {
  login: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/login: app bridge unavailable' };
    const sub = (ctx.args[0] ?? '').toLowerCase();
    app.openPanel('settings-providers');
    openProviderSettings();
    const what =
      sub === 'add'
        ? '在「服务商」页面点击添加，填写 API Key 或选择免密本地服务商（Ollama / LM Studio）。'
        : sub === 'manage'
          ? '在「服务商」页面编辑已有服务商：修改 Key、启用模型、设为默认。'
          : '在「服务商」页面添加或编辑服务商，填写 API Key 并启用模型。';
    const content = [`已打开 设置 → 服务商。`, '', what].join('\n');
    app.toast('已打开服务商设置', 'info');
    return { type: 'text', content };
  },

  logout: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/logout: app bridge unavailable' };
    app.openPanel('settings-providers');
    openProviderSettings();
    const content = [
      '已打开 设置 → 服务商。',
      '',
      '每个服务商独立保存凭据，没有全局登录态：',
      '删除服务商或在服务商页面清空 API Key 即为该服务商登出。',
    ].join('\n');
    app.toast('已打开服务商设置', 'info');
    return { type: 'text', content };
  },

  /** No args → show the current mode + semantics; an arg switches it. */
  permission: (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/permission: app bridge unavailable' };

    const arg = (ctx.args[0] ?? '').trim().toLowerCase();
    const current = app.getSessionSnapshot().permissionMode;

    if (!arg) {
      return {
        type: 'text',
        content: [
          '权限模式 / Permission mode',
          '',
          `  当前：${current ?? '未知'}`,
          '',
          '可选值：',
          ...PERMISSION_MODES.map((mode) => `  ${PERMISSION_LABELS[mode]}`),
          '',
          `用法：/permission ${PERMISSION_MODES.join('|')}`,
        ].join('\n'),
      };
    }

    if (!isPermissionMode(arg)) {
      return {
        type: 'error',
        message: [
          `/permission: 无效的权限模式 "${ctx.args[0]}"。`,
          `可选值：${PERMISSION_MODES.join(' | ')}`,
        ].join('\n'),
      };
    }

    app.setPermissionMode(arg);
    return { type: 'text', content: `权限模式已切换为 ${arg}。` };
  },

  /** Alias entry — dispatch resolves aliases through the canonical name,
   *  this map key only exists so a direct `getCommandExecutor('permissions')`
   *  lookup finds the same handler. */
  permissions: (ctx) => AUTH_EXECUTORS.permission(ctx),
};
