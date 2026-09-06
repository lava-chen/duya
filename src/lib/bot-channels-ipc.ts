/**
 * Bot channel binding IPC client (plan 488, grok-form).
 *
 * Each bot owns its platform connection: `agents/<agentId>/channels/<platform>/`
 * with the token in the per-agent connector-secret store (write-only from the
 * renderer). A live inbound connector wakes the bot's persistent session on
 * every inbound message.
 */

export interface BotChannelManifest {
  platform: string;
  displayName: string;
  blurb: string;
  credentialLabel: string;
  availability: 'available' | 'coming-soon';
  connectGuide?: string;
}

export interface BotChannelConnection {
  platform: string;
  label: string;
  status: 'configured';
}

export interface BotChannelConnectInput {
  platform: string;
  label?: string;
  credential: string;
}

type ElectronAPI = NonNullable<typeof window.electronAPI>;

function api(): ElectronAPI['botChannels'] {
  return window.electronAPI.botChannels;
}

export async function listBotChannelManifests(): Promise<BotChannelManifest[]> {
  const res = (await api().manifests()) as unknown as { manifests?: BotChannelManifest[] };
  return res.manifests ?? [];
}

export async function listBotChannels(agentId: string): Promise<BotChannelConnection[]> {
  const res = (await api().list(agentId)) as { channels?: BotChannelConnection[]; error?: string };
  if (res.error) throw new Error(res.error);
  return res.channels ?? [];
}

export async function connectBotChannel(
  agentId: string,
  input: BotChannelConnectInput,
): Promise<void> {
  const res = await api().connect(agentId, input);
  if (!res.ok) throw new Error(res.error ?? 'connect_failed');
}

export async function disconnectBotChannel(agentId: string, platform: string): Promise<void> {
  const res = await api().disconnect(agentId, platform);
  if (!res.ok) throw new Error(res.error ?? 'disconnect_failed');
}
