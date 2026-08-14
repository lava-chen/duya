export type ChannelId = 'telegram' | 'qq' | 'weixin' | 'feishu' | 'whatsapp';

export const ALL_CHANNEL_IDS: ChannelId[] = ['telegram', 'qq', 'weixin', 'feishu', 'whatsapp'];

export type ConnectMode = 'qr' | 'form';

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  connectMode: ConnectMode;
  /** Whether the bridge/gateway needs to be running for this channel to work. */
  requiresGateway: boolean;
}

export const CHANNEL_METAS: Record<ChannelId, ChannelMeta> = {
  telegram: { id: 'telegram', name: 'Telegram', connectMode: 'form', requiresGateway: true },
  qq: { id: 'qq', name: 'QQ Guild', connectMode: 'form', requiresGateway: true },
  weixin: { id: 'weixin', name: 'WeChat', connectMode: 'qr', requiresGateway: true },
  feishu: { id: 'feishu', name: 'Feishu', connectMode: 'qr', requiresGateway: true },
  whatsapp: { id: 'whatsapp', name: 'WhatsApp', connectMode: 'form', requiresGateway: true },
};

export const SETTINGS_KEYS: Record<ChannelId, { enabled: string; [key: string]: string }> = {
  telegram: { enabled: 'bridge_telegram_enabled', token: 'telegram_bot_token' },
  qq: { enabled: 'bridge_qq_enabled', appId: 'bridge_qq_app_id', appSecret: 'bridge_qq_app_secret' },
  weixin: { enabled: 'bridge_weixin_enabled', token: 'weixin_bot_token', accountId: 'weixin_account_id', baseUrl: 'weixin_base_url' },
  feishu: { enabled: 'bridge_feishu_enabled', appId: 'bridge_feishu_app_id', appSecret: 'bridge_feishu_app_secret' },
  whatsapp: { enabled: 'bridge_whatsapp_enabled', sessionPath: 'whatsapp_session_path' },
};

export interface AdapterHealth {
  connected: boolean;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  totalMessages: number;
  botUsername?: string;
}

export interface BridgeAdapter {
  platform: string;
  running: boolean;
  lastMessageAt?: number;
  error?: string;
  health?: AdapterHealth;
}

export interface BridgeStatus {
  running: boolean;
  adapters: BridgeAdapter[];
  autoStart: boolean;
  _orphaned?: boolean;
}

export interface BridgeSettings {
  'bridge_telegram_enabled': string;
  'telegram_bot_token': string;
  'bridge_qq_enabled': string;
  'bridge_qq_app_id': string;
  'bridge_qq_app_secret': string;
  'bridge_weixin_enabled': string;
  'weixin_bot_token': string;
  'weixin_account_id': string;
  'weixin_base_url': string;
  'bridge_feishu_enabled': string;
  'bridge_feishu_app_id': string;
  'bridge_feishu_app_secret': string;
  'bridge_whatsapp_enabled': string;
  'whatsapp_session_path': string;
  'bridge_auto_start': string;
  'bridge_proxy_url': string;
  'bridge_workspace': string;
}