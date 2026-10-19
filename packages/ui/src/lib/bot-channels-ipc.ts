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
  credentialFields?: Array<{ field: string; label: string; secret: boolean; required?: boolean }>;
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

/** Begin a QR connect flow (feishu/weixin): returns a sessionId + QR data URL. */
export async function beginBotChannelQr(
  agentId: string,
  platform: string,
  label?: string,
): Promise<{ sessionId: string; qrImage: string }> {
  const res = await api().qrBegin(agentId, platform, label ? { label } : undefined);
  if (!res.ok) throw new Error(res.error ?? 'qr_begin_failed');
  if (!res.sessionId || !res.qrImage) throw new Error('qr_begin_failed');
  return { sessionId: res.sessionId, qrImage: res.qrImage };
}

/** Poll a QR session. Returns "bound" once the bot is connected. */
export async function pollBotChannelQr(sessionId: string): Promise<{ status: string }> {
  const res = await api().qrPoll(sessionId);
  if (!res.ok) throw new Error(res.error ?? 'qr_poll_failed');
  return { status: res.status ?? 'waiting' };
}

/** Cancel an in-flight QR session. */
export async function cancelBotChannelQr(sessionId: string): Promise<void> {
  await api().qrCancel(sessionId);
}
