/**
 * Bot channel binding IPC client.
 *
 * A binding is a gateway profile route: (platform[, chatId]) → this bot's
 * config-agent id. Inbound gateway messages (telegram/weixin/feishu/qq/…)
 * on the bound platform/chat run with the bot's persona. Platform
 * credentials live in the gateway's own channel config and are not touched
 * here.
 */

export interface GatewayPlatformInfo {
  platform: string;
  enabled: boolean;
  hasCredentials: boolean;
}

export interface BotChannelRoute {
  name?: string;
  platform: string;
  /** Bot config-agent id the channel is bound to. */
  profile: string;
  /** Present on chat-level routes; absent on platform-default routes. */
  chatId?: string;
  threadId?: string;
  enabled?: boolean;
}

export interface BotChannelConnectInput {
  platform: string;
  /** Omit to bind the whole platform (default route for every chat). */
  chatId?: string;
  threadId?: string;
  label?: string;
}

type ElectronAPI = NonNullable<typeof window.electronAPI>;

function api(): ElectronAPI['botChannels'] {
  return window.electronAPI.botChannels;
}

export async function listGatewayPlatformInfo(): Promise<GatewayPlatformInfo[]> {
  const res = (await api().manifests()) as unknown as { platforms?: GatewayPlatformInfo[] };
  return res.platforms ?? [];
}

export async function listBotChannelRoutes(agentId: string): Promise<BotChannelRoute[]> {
  const res = (await api().list(agentId)) as { routes?: BotChannelRoute[]; error?: string };
  if (res.error) throw new Error(res.error);
  return res.routes ?? [];
}

export async function connectBotChannel(
  agentId: string,
  input: BotChannelConnectInput,
): Promise<void> {
  const res = await api().connect(agentId, input);
  if (!res.ok) throw new Error(res.error ?? 'connect_failed');
}

export async function disconnectBotChannel(
  agentId: string,
  platform: string,
  chatId?: string,
): Promise<void> {
  const res = await api().disconnect(agentId, platform, chatId);
  if (!res.ok) throw new Error(res.error ?? 'disconnect_failed');
}
