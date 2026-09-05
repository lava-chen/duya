/**
 * Bot channel binding IPC client (plan 488).
 *
 * Thin wrapper over the `botChannels` preload API. Each bot (agent) binds its
 * own channels — `agents/<agentId>/channels/<platform>/connection.json` — and
 * credentials live only in the main-process secret store (write-only here).
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
  const { manifests } = await api().manifests();
  return manifests as unknown as BotChannelManifest[];
}

export async function listBotChannels(agentId: string): Promise<BotChannelConnection[]> {
  const res = await api().list(agentId);
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
