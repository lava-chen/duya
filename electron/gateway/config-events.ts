/**
 * 进程内事件总线 —— 用于在修改 gateway 配置的 IPC handler 与 gateway lifecycle 之间解耦。
 *
 * 写入端：electron/ipc/db-handlers.ts (db:setting:set, db:setting:setJson, weixin account CRUD)
 *         electron/ipc/settings-handlers.ts (gateway proxy config)
 * 读取端：electron/gateway/message-bus.ts (订阅 → 触发 reloadGatewayProcess)
 *
 * 注意：这是 **主进程内部** 的 EventEmitter，不会跨 IPC 边界。
 * renderer 不需要订阅这个事件 —— 前端 BridgeSection.updateSetting 已经主动调 gateway:reload。
 */
import { EventEmitter } from 'events';

export interface GatewayConfigChangedPayload {
  /** 哪个 key / 哪个 handler 触发的，便于日志诊断 */
  source: string;
}

class GatewayConfigEvents extends EventEmitter {
  emitConfigChanged(payload: GatewayConfigChangedPayload): void {
    this.emit('changed', payload);
  }

  onConfigChanged(listener: (payload: GatewayConfigChangedPayload) => void): void {
    this.on('changed', listener);
  }

  offConfigChanged(listener: (payload: GatewayConfigChangedPayload) => void): void {
    this.off('changed', listener);
  }
}

// 单例 —— Node 模块缓存保证整个主进程共享同一个实例
export const gatewayConfigEvents = new GatewayConfigEvents();
gatewayConfigEvents.setMaxListeners(20);

/**
 * 在 DB 写入完成后调用。内部已 try/catch，调用方无需处理。
 */
export function emitGatewayConfigChanged(source: string): void {
  try {
    gatewayConfigEvents.emitConfigChanged({ source });
  } catch (err) {
    // emitter 异常不应影响主流程（DB 已经写完了）
    console.error('[GatewayConfigEvents] emit failed:', err);
  }
}

/**
 * 判断一个 settings key 是否会影响 gateway 启动配置。
 * 用在 db:setting:setJson 这种通用写入 handler 里，避免无关 key 也触发 reload。
 */
export function isGatewayConfigKey(key: string): boolean {
  if (key === 'bridge_auto_start') return true;
  if (key === 'gatewayModel') return true;
  if (key.startsWith('bridge_')) return true;            // bridge_telegram_enabled, bridge_qq_app_id, ...
  if (key.startsWith('telegram_')) return true;          // telegram_bot_token
  if (key.startsWith('bridge_qq_')) return true;         // bridge_qq_app_secret
  if (key.startsWith('weixin_')) return true;            // weixin_bot_token, weixin_account_id, weixin_base_url
  if (key.startsWith('feishu_') || key.startsWith('bridge_feishu_')) return true;
  if (key === 'bridge_proxy_url' || key === 'bridge_workspace') return true;
  if (key.startsWith('whatsapp_') || key.startsWith('bridge_whatsapp_')) return true;
  return false;
}
