'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  WifiHighIcon,
  SpinnerGapIcon,
  PlayCircleIcon,
  StopIcon,
  CircleNotchIcon,
  CheckCircleIcon,
  XCircleIcon,
  GlobeHemisphereWestIcon,
  ArrowsClockwiseIcon,
  TrashIcon,
  GlobeIcon,
} from '@/components/icons';
import { ChannelIcon, CHANNEL_COLORS } from '@/components/bridge/ChannelIcon';
import { useTranslation } from '@/hooks/useTranslation';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
  SettingsSelectRow,
} from '@/components/settings/ui';
import { cn } from '@/lib/utils';

interface BridgeStatus {
  running: boolean;
  adapters: Array<{
    channelType: string;
    running: boolean;
    lastMessageAt?: number;
    error?: string;
  }>;
  autoStart: boolean;
}

interface BridgeSettings {
  'remote_bridge_enabled': string;
  'bridge_auto_start': string;
  'bridge_proxy_url': string;
  'bridge_workspace': string;
  'bridge_telegram_enabled': string;
  'telegram_bot_token': string;
  'bridge_qq_enabled': string;
  'bridge_qq_app_id': string;
  'bridge_qq_app_secret': string;
  'bridge_qq_sandbox': string;
  'bridge_weixin_enabled': string;
  'weixin_bot_token': string;
  'weixin_account_id': string;
  'weixin_base_url': string;
  'bridge_feishu_enabled': string;
  'bridge_feishu_app_id': string;
  'bridge_feishu_app_secret': string;
  'bridge_feishu_domain': string;
  'bridge_feishu_dm_policy': string;
  'bridge_feishu_group_policy': string;
  'bridge_feishu_require_mention': string;
  'bridge_feishu_thread_session': string;
  'bridge_whatsapp_enabled': string;
  'whatsapp_session_path': string;
  'whatsapp_dm_policy': string;
  'whatsapp_group_policy': string;
  'whatsapp_require_mention': string;
  'whatsapp_free_response_chats': string;
  'whatsapp_mention_patterns': string;
}

interface ProxyStatus {
  configured: string | undefined;
  env: string | undefined;
  system: string | undefined;
  effective: string | undefined;
}

interface TestResult {
  success: boolean;
  message: string;
  details?: string;
}

type ChannelType = 'telegram' | 'qq' | 'weixin' | 'feishu' | 'whatsapp';

interface ChannelInfo {
  id: ChannelType;
  name: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

export default function BridgeSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [settings, setSettings] = useState<BridgeSettings | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [activeChannel, setActiveChannel] = useState<ChannelType>('telegram');

  const channels: ChannelInfo[] = [
    {
      id: 'telegram',
      name: t('bridge.telegram'),
      icon: <ChannelIcon channel="telegram" size={18} style={{ color: CHANNEL_COLORS.telegram.color }} />,
      color: CHANNEL_COLORS.telegram.color,
      bgColor: CHANNEL_COLORS.telegram.bgColor,
    },
    {
      id: 'qq',
      name: t('bridge.qqGuild'),
      icon: <ChannelIcon channel="qq" size={18} style={{ color: CHANNEL_COLORS.qq.color }} />,
      color: CHANNEL_COLORS.qq.color,
      bgColor: CHANNEL_COLORS.qq.bgColor,
    },
    {
      id: 'weixin',
      name: t('bridge.wechat'),
      icon: <ChannelIcon channel="weixin" size={18} style={{ color: CHANNEL_COLORS.weixin.color }} />,
      color: CHANNEL_COLORS.weixin.color,
      bgColor: CHANNEL_COLORS.weixin.bgColor,
    },
    {
      id: 'feishu',
      name: t('bridge.feishu'),
      icon: <ChannelIcon channel="feishu" size={18} style={{ color: CHANNEL_COLORS.feishu.color }} />,
      color: CHANNEL_COLORS.feishu.color,
      bgColor: CHANNEL_COLORS.feishu.bgColor,
    },
    {
      id: 'whatsapp',
      name: t('bridge.whatsapp'),
      icon: <ChannelIcon channel="whatsapp" size={18} style={{ color: CHANNEL_COLORS.whatsapp.color }} />,
      color: CHANNEL_COLORS.whatsapp.color,
      bgColor: CHANNEL_COLORS.whatsapp.bgColor,
    },
  ];

  useEffect(() => {
    fetchStatus();
    fetchSettings();
    fetchProxyStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const data = await window.electronAPI?.gateway?.getStatus();
      if (data) {
        setStatus(data as BridgeStatus);
      }
    } catch {
      // Ignore network errors
    }
  };

  const fetchSettings = async () => {
    try {
      const allSettings = await window.electronAPI?.settingsDb?.getAll() as Record<string, string> | undefined;
      if (allSettings) {
        const bridgeSettings: BridgeSettings = {
          'remote_bridge_enabled': allSettings['remote_bridge_enabled'] || 'false',
          'bridge_auto_start': allSettings['bridge_auto_start'] || 'false',
          'bridge_proxy_url': allSettings['bridge_proxy_url'] || '',
          'bridge_workspace': allSettings['bridge_workspace'] || '',
          'bridge_telegram_enabled': allSettings['bridge_telegram_enabled'] || 'false',
          'telegram_bot_token': allSettings['telegram_bot_token'] || '',
          'bridge_qq_enabled': allSettings['bridge_qq_enabled'] || 'false',
          'bridge_qq_app_id': allSettings['bridge_qq_app_id'] || '',
          'bridge_qq_app_secret': allSettings['bridge_qq_app_secret'] || '',
          'bridge_qq_sandbox': allSettings['bridge_qq_sandbox'] || 'false',
          'bridge_weixin_enabled': allSettings['bridge_weixin_enabled'] || 'false',
          'weixin_bot_token': allSettings['weixin_bot_token'] || '',
          'weixin_account_id': allSettings['weixin_account_id'] || '',
          'weixin_base_url': allSettings['weixin_base_url'] || '',
          'bridge_feishu_enabled': allSettings['bridge_feishu_enabled'] || 'false',
          'bridge_feishu_app_id': allSettings['bridge_feishu_app_id'] || '',
          'bridge_feishu_app_secret': allSettings['bridge_feishu_app_secret'] || '',
          'bridge_feishu_domain': allSettings['bridge_feishu_domain'] || '',
          'bridge_feishu_dm_policy': allSettings['bridge_feishu_dm_policy'] || '',
          'bridge_feishu_group_policy': allSettings['bridge_feishu_group_policy'] || '',
          'bridge_feishu_require_mention': allSettings['bridge_feishu_require_mention'] || '',
          'bridge_feishu_thread_session': allSettings['bridge_feishu_thread_session'] || '',
          'bridge_whatsapp_enabled': allSettings['bridge_whatsapp_enabled'] || 'false',
          'whatsapp_session_path': allSettings['whatsapp_session_path'] || '',
          'whatsapp_dm_policy': allSettings['whatsapp_dm_policy'] || 'open',
          'whatsapp_group_policy': allSettings['whatsapp_group_policy'] || 'open',
          'whatsapp_require_mention': allSettings['whatsapp_require_mention'] || 'true',
          'whatsapp_free_response_chats': allSettings['whatsapp_free_response_chats'] || '',
          'whatsapp_mention_patterns': allSettings['whatsapp_mention_patterns'] || '',
        };
        setSettings(bridgeSettings);
      }
    } catch {
      // Ignore network errors
    } finally {
      setLoading(false);
    }
  };

  const fetchProxyStatus = async () => {
    try {
      const result = await window.electronAPI?.gateway?.getProxyStatus();
      if (result?.success && result.status) {
        setProxyStatus(result.status);
      }
    } catch {
      // Ignore errors
    }
  };

  const updateSetting = async (key: string, value: string) => {
    setLoading(true);
    setError(null);
    const channel = keyToChannel(key);
    if (channel) {
      setTestResults(prev => {
        const next = { ...prev };
        delete next[channel];
        return next;
      });
    }
    try {
      await window.electronAPI?.settingsDb?.set(key, value);
      await fetchSettings();

      if (status?.running) {
        try {
          await window.electronAPI?.gateway?.reload();
          await fetchStatus();
        } catch (err) {
          console.error('[Channels] Failed to reload gateway:', err);
        }
      }
    } catch {
      setError('Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  const controlBridge = async (action: 'start' | 'stop' | 'auto-start') => {
    setLoading(true);
    setError(null);
    try {
      if (action === 'start') {
        const result = await window.electronAPI?.gateway?.start();
        if (result && !result.success) {
          throw new Error(result.error || 'Failed to start gateway');
        }
      } else if (action === 'stop') {
        const result = await window.electronAPI?.gateway?.stop();
        if (result && !result.success) {
          throw new Error(result.error || 'Failed to stop gateway');
        }
      } else if (action === 'auto-start') {
        const newValue = status?.autoStart ? 'false' : 'true';
        await updateSetting('bridge_auto_start', newValue);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to control gateway');
    } finally {
      setLoading(false);
    }
  };

  const testConnection = async (channel: string) => {
    setTestingChannel(channel);
    setTestResults(prev => {
      const next = { ...prev };
      delete next[channel];
      return next;
    });
    try {
      const result = await window.electronAPI?.gateway?.testChannel(channel);
      if (result) {
        setTestResults(prev => ({ ...prev, [channel]: result }));
      }
    } catch {
      setTestResults(prev => ({
        ...prev,
        [channel]: { success: false, message: 'Test failed', details: 'Network error' }
      }));
    } finally {
      setTestingChannel(null);
    }
  };

  const getChannelStatus = (channelId: ChannelType) => {
    const adapter = status?.adapters.find(a => a.channelType === channelId);
    const isRunning = adapter?.running ?? false;
    const hasError = adapter?.error && adapter.error.length > 0;
    const enabledKey = `bridge_${channelId}_enabled` as keyof BridgeSettings;
    const isEnabled = settings?.[enabledKey] === 'true';

    if (!isEnabled) return { label: 'Disabled', color: 'var(--muted)', bgColor: 'var(--surface)' };
    if (isRunning) return { label: 'Active', color: 'var(--success)', bgColor: 'var(--success-soft)' };
    if (hasError) return { label: 'Error', color: 'var(--error)', bgColor: 'var(--error-soft)' };
    return { label: 'Connecting', color: 'var(--warning)', bgColor: 'var(--warning-soft)' };
  };

  if (loading && !settings) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="settings-section h-full flex flex-col">
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Bridge Control Section */}
      <SettingsSection title={t('bridge.bridgeControl')} description={t('bridge.bridgeControlDesc')}>
        <SettingsCard>
          <SettingsRow
            label={t('bridge.status')}
            description={t("bridge.bridgeConnectionStatus")}
            action={
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${
                    status?.running
                      ? "bg-green-500/10 text-green-500 border border-green-500/20"
                      : "bg-muted text-muted-foreground border border-border/20"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${status?.running ? "bg-green-500" : "bg-muted-foreground"}`} />
                  {status?.running ? t("bridge.running") : t("bridge.stopped")}
                </span>
                <button
                  onClick={() => controlBridge(status?.running ? 'stop' : 'start')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                    status?.running
                      ? "border-red-500/30 text-red-500 hover:bg-red-500/10"
                      : "border-green-500/30 text-green-500 hover:bg-green-500/10"
                  }`}
                >
                  {status?.running ? <StopIcon size={14} /> : <PlayCircleIcon size={14} />}
                  {status?.running ? t("bridge.stop") : t("bridge.start")}
                </button>
              </div>
            }
          />
          <SettingsToggle
            label={t("bridge.autoStart")}
            description={t("bridge.autoStartDesc")}
            checked={status?.autoStart ?? false}
            onCheckedChange={() => controlBridge('auto-start')}
          />
          <SettingsInput
            label={t("bridge.proxyUrl")}
            description={t("bridge.proxyUrlDesc")}
            value={settings?.['bridge_proxy_url'] || ''}
            onChange={(v) => updateSetting('bridge_proxy_url', v)}
            placeholder="http://127.0.0.1:7890"
            action={
              <button
                onClick={fetchProxyStatus}
                className="p-2 rounded-lg border border-border/50 hover:bg-muted transition-colors shrink-0"
                title="Refresh proxy detection"
              >
                <ArrowsClockwiseIcon size={14} />
              </button>
            }
          />
          {proxyStatus && (
            <div className="px-4 pb-3.5">
              {proxyStatus.effective ? (
                <div className="flex items-center gap-2 text-xs">
                  <GlobeHemisphereWestIcon size={12} className="text-green-500" />
                  <span className="text-green-500">Active: {proxyStatus.effective}</span>
                  {proxyStatus.configured && <span className="text-muted-foreground">(configured)</span>}
                  {!proxyStatus.configured && proxyStatus.env && <span className="text-muted-foreground">(from env)</span>}
                  {!proxyStatus.configured && !proxyStatus.env && proxyStatus.system && (
                    <span className="text-muted-foreground">(system)</span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <GlobeHemisphereWestIcon size={12} />
                  <span>No proxy detected — direct connection</span>
                </div>
              )}
            </div>
          )}
          <SettingsInput
            label={t('bridge.defaultWorkspace')}
            description={t('bridge.defaultWorkspaceDesc')}
            value={settings?.['bridge_workspace'] || ''}
            onChange={(v) => updateSetting('bridge_workspace', v)}
            placeholder="~/.duya/workspace"
          />
        </SettingsCard>
      </SettingsSection>

      {/* Channels Section with Sidebar Layout */}
      <SettingsSection title={t('bridge.channels')} description={t('bridge.configureMessagingPlatforms')} className="flex-1 min-h-0">
        <div className="flex h-full min-h-[400px] border border-border/50 rounded-xl overflow-hidden bg-card">
          {/* Sidebar - Channel List */}
          <nav className="w-56 shrink-0 border-r border-border/50 bg-muted/30 flex flex-col">
            <div className="p-3 border-b border-border/50">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('bridge.platforms')}</h3>
            </div>
            <div className="flex-1 overflow-auto p-2 space-y-1">
              {channels.map((channel) => {
                const isActive = activeChannel === channel.id;
                const enabledKey = `bridge_${channel.id}_enabled` as keyof BridgeSettings;
                const isEnabled = settings?.[enabledKey] === 'true';
                return (
                  <button
                    key={channel.id}
                    onClick={() => setActiveChannel(channel.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all duration-200",
                      isActive
                        ? "bg-accent text-accent-foreground shadow-sm"
                        : "hover:bg-muted/80 text-foreground"
                    )}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-200"
                      style={{
                        backgroundColor: isActive ? 'rgba(255,255,255,0.2)' : channel.bgColor,
                        color: isActive ? 'currentColor' : channel.color,
                      }}
                    >
                      {channel.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{channel.name}</p>
                    </div>
                    <div
                      className={cn(
                        "w-8 h-4 rounded-full transition-colors duration-200 relative",
                        isEnabled ? "bg-green-500" : "bg-muted-foreground/30"
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateSetting(enabledKey, isEnabled ? 'false' : 'true');
                      }}
                    >
                      <div
                        className={cn(
                          "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-200",
                          isEnabled ? "translate-x-4" : "translate-x-0.5"
                        )}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Content - Channel Settings */}
          <div className="flex-1 overflow-auto bg-card">
            {/* Telegram Settings */}
            {activeChannel === 'telegram' && (
              <ChannelSettingsPanel
                title={t('bridge.telegram')}
                enabled={settings?.['bridge_telegram_enabled'] === 'true'}
                running={status?.adapters.find(a => a.channelType === 'telegram')?.running}
                onTest={() => testConnection('telegram')}
                testing={testingChannel === 'telegram'}
                testResult={testResults['telegram']}
              >
                <SettingsInput
                  label="Bot Token"
                  description="Get token from @BotFather"
                  type="password"
                  value={settings?.['telegram_bot_token'] || ''}
                  onChange={(v) => updateSetting('telegram_bot_token', v)}
                  placeholder="123456:ABC-DEF..."
                />
              </ChannelSettingsPanel>
            )}

            {/* QQ Settings */}
            {activeChannel === 'qq' && (
              <ChannelSettingsPanel
                title={t('bridge.qq')}
                enabled={settings?.['bridge_qq_enabled'] === 'true'}
                running={status?.adapters.find(a => a.channelType === 'qq')?.running}
                onTest={() => testConnection('qq')}
                testing={testingChannel === 'qq'}
                testResult={testResults['qq']}
              >
                <SettingsInput
                  label={t('bridge.appId')}
                  description={t('bridge.qqAppIdDesc')}
                  value={settings?.['bridge_qq_app_id'] || ''}
                  onChange={(v) => updateSetting('bridge_qq_app_id', v)}
                  placeholder="1023456789"
                />
                <SettingsInput
                  label={t('bridge.appSecret')}
                  description={t('bridge.qqAppSecretDesc')}
                  type="password"
                  value={settings?.['bridge_qq_app_secret'] || ''}
                  onChange={(v) => updateSetting('bridge_qq_app_secret', v)}
                  placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <SettingsToggle
                  label={t('bridge.qqSandbox')}
                  description={t('bridge.qqSandboxDesc')}
                  checked={settings?.['bridge_qq_sandbox'] === 'true'}
                  onCheckedChange={(checked) => updateSetting('bridge_qq_sandbox', checked ? 'true' : 'false')}
                />
              </ChannelSettingsPanel>
            )}

            {/* WeChat Settings */}
            {activeChannel === 'weixin' && (
              <WeChatSettingsPanel
                enabled={settings?.['bridge_weixin_enabled'] === 'true'}
                running={status?.adapters.find(a => a.channelType === 'weixin')?.running}
                onTest={() => testConnection('weixin')}
                testing={testingChannel === 'weixin'}
                testResult={testResults['weixin']}
                settings={settings}
                updateSetting={updateSetting}
                onSettingsChange={fetchSettings}
              />
            )}

            {/* Feishu Settings */}
            {activeChannel === 'feishu' && (
              <ChannelSettingsPanel
                title={t('bridge.feishu')}
                enabled={settings?.['bridge_feishu_enabled'] === 'true'}
                running={status?.adapters.find(a => a.channelType === 'feishu')?.running}
                onTest={() => testConnection('feishu')}
                testing={testingChannel === 'feishu'}
                testResult={testResults['feishu']}
              >
                <SettingsInput
                  label="App ID"
                  description="Feishu Open Platform app ID"
                  value={settings?.['bridge_feishu_app_id'] || ''}
                  onChange={(v) => updateSetting('bridge_feishu_app_id', v)}
                  placeholder="cli_xxxxxxxxxxxxxx"
                />
                <SettingsInput
                  label="App Secret"
                  type="password"
                  value={settings?.['bridge_feishu_app_secret'] || ''}
                  onChange={(v) => updateSetting('bridge_feishu_app_secret', v)}
                  placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <SettingsSelectRow
                  label="Domain"
                  description="Feishu (China) or Lark (International)"
                  value={settings?.['bridge_feishu_domain'] || 'feishu'}
                  onValueChange={(v) => updateSetting('bridge_feishu_domain', v)}
                  options={[
                    { value: 'feishu', label: 'Feishu (飞书)' },
                    { value: 'lark', label: 'Lark (国际版)' },
                  ]}
                />
                <SettingsSelectRow
                  label="DM Policy"
                  description="Who can send DMs to the bot"
                  value={settings?.['bridge_feishu_dm_policy'] || 'open'}
                  onValueChange={(v) => updateSetting('bridge_feishu_dm_policy', v)}
                  options={[
                    { value: 'open', label: 'Open - All users' },
                    { value: 'allowlist', label: 'Allowlist - Specific users only' },
                    { value: 'pairing', label: 'Pairing mode' },
                    { value: 'disabled', label: 'Disabled' },
                  ]}
                />
                <SettingsSelectRow
                  label="Group Policy"
                  description="Bot behavior in group chats"
                  value={settings?.['bridge_feishu_group_policy'] || 'open'}
                  onValueChange={(v) => updateSetting('bridge_feishu_group_policy', v)}
                  options={[
                    { value: 'open', label: 'Open - All groups' },
                    { value: 'allowlist', label: 'Allowlist - Specific groups only' },
                    { value: 'disabled', label: 'Disabled' },
                  ]}
                />
                <SettingsToggle
                  label="Require @mention"
                  description="Only respond when bot is mentioned in groups"
                  checked={settings?.['bridge_feishu_require_mention'] === 'true'}
                  onCheckedChange={(checked) => updateSetting('bridge_feishu_require_mention', checked ? 'true' : 'false')}
                />
                <SettingsToggle
                  label="Thread Sessions"
                  description="Use per-thread sessions for context"
                  checked={settings?.['bridge_feishu_thread_session'] === 'true'}
                  onCheckedChange={(checked) => updateSetting('bridge_feishu_thread_session', checked ? 'true' : 'false')}
                />
              </ChannelSettingsPanel>
            )}

            {/* WhatsApp Settings */}
            {activeChannel === 'whatsapp' && (
              <WhatsAppSettingsPanel
                enabled={settings?.['bridge_whatsapp_enabled'] === 'true'}
                running={status?.adapters.find(a => a.channelType === 'whatsapp')?.running}
                onTest={() => testConnection('whatsapp')}
                testing={testingChannel === 'whatsapp'}
                testResult={testResults['whatsapp']}
                settings={settings}
                updateSetting={updateSetting}
              />
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

// WeChat account from database
interface WeixinAccount {
  account_id: string;
  user_id: string;
  name: string;
  base_url: string;
  cdn_base_url: string;
  token: string;
  enabled: number;
  last_login_at: number;
}

function WeChatSettingsPanel({
  enabled,
  running,
  onTest,
  testing,
  testResult,
  settings,
  updateSetting,
  onSettingsChange,
}: {
  enabled: boolean;
  running?: boolean;
  onTest: () => void;
  testing: boolean;
  testResult?: TestResult;
  settings: BridgeSettings | null;
  updateSetting: (key: string, value: string) => Promise<void>;
  onSettingsChange: () => void;
}) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<WeixinAccount[]>([]);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrSessionId, setQrSessionId] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState<string>('');
  const [qrLoading, setQrLoading] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await window.electronAPI?.weixin?.getAccounts();
      if (data) {
        setAccounts(data as WeixinAccount[]);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  const handleToggleAccount = async (accountId: string, accountEnabled: boolean) => {
    try {
      await window.electronAPI?.weixin?.updateAccount(accountId, { enabled: accountEnabled });
      fetchAccounts();
    } catch { /* ignore */ }
  };

  const handleDeleteAccount = async (accountId: string) => {
    try {
      await window.electronAPI?.weixin?.deleteAccount(accountId);
      setDeleteConfirm(null);
      fetchAccounts();
    } catch { /* ignore */ }
  };

  const pollQrStatus = useCallback(async (sessionId: string) => {
    try {
      const data = await window.electronAPI?.net?.weixinQrPoll(sessionId);
      if (!data || !data.success) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setQrStatus('failed');
        return;
      }

      setQrStatus(data.status || '');

      if (data.qr_image && data.status === 'waiting') {
        setQrImage(data.qr_image);
      }

      if (data.status === 'confirmed' || data.status === 'failed') {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        if (data.status === 'confirmed') {
          fetchAccounts();
          onSettingsChange();
          try {
            await window.electronAPI?.gateway?.reload();
          } catch { /* ignore reload errors */ }
          setTimeout(() => {
            setQrImage(null);
            setQrSessionId(null);
            setQrStatus('');
          }, 2000);
        }
      }
    } catch { /* ignore */ }
  }, [fetchAccounts, onSettingsChange]);

  const startQrLogin = async () => {
    setQrLoading(true);
    setQrStatus('');
    try {
      const data = await window.electronAPI?.net?.weixinQrStart();
      if (!data || !data.success) {
        throw new Error(data?.error || 'Failed to start QR login');
      }
      setQrImage(data.qrImage || null);
      setQrSessionId(data.sessionId || null);
      setQrStatus('waiting');

      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(() => pollQrStatus(data.sessionId!), 3000);
    } catch (err) {
      setQrStatus('failed');
    } finally {
      setQrLoading(false);
    }
  };

  const cancelQrLogin = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (qrSessionId) {
      window.electronAPI?.net?.weixinQrCancel(qrSessionId);
    }
    setQrImage(null);
    setQrSessionId(null);
    setQrStatus('');
  };

  const hasAccounts = accounts.length > 0;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{t('bridge.wechat')}</h2>
          {enabled && running !== undefined && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                running
                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                  : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green-500" : "bg-yellow-500"}`} />
              {running ? t('bridge.connected') : t('bridge.disconnected')}
            </span>
          )}
        </div>
        <button
          onClick={onTest}
          disabled={testing || !enabled}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 hover:bg-muted transition-all disabled:opacity-50"
        >
          {testing ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : testResult ? (
            testResult.success ? (
              <CheckCircleIcon size={14} className="text-green-500" />
            ) : (
              <XCircleIcon size={14} className="text-destructive" />
            )
          ) : (
            <CircleNotchIcon size={14} />
          )}
          {t('bridge.test')}
        </button>
      </div>

      {/* Test Result */}
      {testResult && (
        <div className={`mb-6 p-3 rounded-lg ${
          testResult.success
            ? 'bg-green-500/10 border border-green-500/30'
            : 'bg-red-500/10 border border-red-500/30'
        }`}>
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <CheckCircleIcon size={16} className="text-green-500 shrink-0" />
            ) : (
              <XCircleIcon size={16} className="text-destructive shrink-0" />
            )}
            <div>
              <p className={`text-sm font-medium ${testResult.success ? 'text-green-500' : 'text-destructive'}`}>
                {testResult.message}
              </p>
              {testResult.details && (
                <p className="text-xs text-muted-foreground mt-0.5">{testResult.details}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Content - Always visible */}
      <div className="space-y-6">
        {/* Accounts Section */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t('bridge.accounts')}</h3>
          {hasAccounts ? (
            <div className="space-y-2">
              {accounts.map(account => (
                <div
                  key={account.account_id}
                  className="flex items-center justify-between rounded-lg border border-border/30 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{account.name || account.account_id}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.enabled ? 'Active' : 'Paused'}
                      {account.token ? '' : ' · Expired'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-3">
                    <SettingsToggle
                      label=""
                      checked={account.enabled === 1}
                      onCheckedChange={(checked) => handleToggleAccount(account.account_id, checked)}
                    />
                    {deleteConfirm === account.account_id ? (
                      <div className="flex items-center gap-1">
                        <button
                          className="text-xs px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                          onClick={() => handleDeleteAccount(account.account_id)}
                        >
                          Delete
                        </button>
                        <button
                          className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => setDeleteConfirm(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="text-muted-foreground hover:text-destructive text-xs transition-colors"
                        onClick={() => setDeleteConfirm(account.account_id)}
                      >
                        <TrashIcon size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-2">{t('bridge.noAccountsConfigured')}</p>
          )}

          {/* QR Login */}
          {!qrImage ? (
            <button
              onClick={startQrLogin}
              disabled={qrLoading}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/90 transition-all shadow-sm"
            >
              {qrLoading ? <SpinnerGapIcon size={16} className="animate-spin" /> : <GlobeIcon size={16} />}
              {t('bridge.addAccountQr')}
            </button>
          ) : (
            <div className="mt-3 rounded-lg border border-border/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <GlobeIcon size={16} />
                  {t('bridge.wechatQrLogin')}
                </h3>
                <button
                  className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 transition-colors"
                  onClick={cancelQrLogin}
                >
                  {t('bridge.cancel')}
                </button>
              </div>

              <div className="flex justify-center">
                <img
                  src={qrImage}
                  alt="WeChat QR Code"
                  className="w-48 h-48 rounded-lg border border-border/30"
                />
              </div>

              <div className="text-center">
                {qrStatus === 'waiting' && (
                  <div className="flex items-center justify-center gap-2 text-sm text-blue-500">
                    <SpinnerGapIcon size={14} className="animate-spin" />
                    {t('bridge.waitingForScan')}
                  </div>
                )}
                {qrStatus === 'scanned' && (
                  <div className="flex items-center justify-center gap-2 text-sm text-blue-500">
                    <CheckCircleIcon size={14} />
                    {t('bridge.scanned')}
                  </div>
                )}
                {qrStatus === 'confirmed' && (
                  <div className="flex items-center justify-center gap-2 text-sm text-green-500">
                    <CheckCircleIcon size={14} />
                    {t('bridge.loginSuccess')}
                  </div>
                )}
                {qrStatus === 'expired' && (
                  <div className="flex items-center justify-center gap-2 text-sm text-yellow-500">
                    <CircleNotchIcon size={14} />
                    {t('bridge.qrExpired')}
                  </div>
                )}
                {qrStatus === 'failed' && (
                  <div className="flex items-center justify-center gap-2 text-sm text-destructive">
                    <XCircleIcon size={14} />
                    {t('bridge.loginFailed')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Manual Configuration - Collapsed by default */}
        <details className="pt-4 border-t border-border/30 group">
          <summary className="text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer list-none flex items-center gap-2 transition-colors">
            <span>{t('bridge.manualConfig')}</span>
            <span className="text-xs text-muted-foreground/60">({t('bridge.manualConfigAdvanced')})</span>
          </summary>
          <div className="mt-4 space-y-4">
            <SettingsInput
              label="Bot Token"
              description="iLink Bot Token from QR login"
              type="password"
              value={settings?.['weixin_bot_token'] || ''}
              onChange={(v) => updateSetting('weixin_bot_token', v)}
              placeholder="Paste token from QR login..."
            />
            <SettingsInput
              label="Account ID"
              description="iLink Bot ID (from QR login)"
              value={settings?.['weixin_account_id'] || ''}
              onChange={(v) => updateSetting('weixin_account_id', v)}
              placeholder="e.g., ilink_xxxxxxxx"
            />
            <SettingsInput
              label="Base URL"
              description="iLink API endpoint (optional)"
              value={settings?.['weixin_base_url'] || ''}
              onChange={(v) => updateSetting('weixin_base_url', v)}
              placeholder="https://ilinkai.weixin.qq.com"
            />
          </div>
        </details>
      </div>
    </div>
  );
}

function ChannelSettingsPanel({
  title,
  enabled,
  running,
  onTest,
  testing,
  testResult,
  children,
}: {
  title: string;
  enabled: boolean;
  running?: boolean;
  onTest: () => void;
  testing: boolean;
  testResult?: TestResult;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          {enabled && running !== undefined && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                running
                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                  : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green-500" : "bg-yellow-500"}`} />
              {running ? t('bridge.connected') : t('bridge.disconnected')}
            </span>
          )}
        </div>
        <button
          onClick={onTest}
          disabled={testing || !enabled}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 hover:bg-muted transition-all disabled:opacity-50"
        >
          {testing ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : testResult ? (
            testResult.success ? (
              <CheckCircleIcon size={14} className="text-green-500" />
            ) : (
              <XCircleIcon size={14} className="text-destructive" />
            )
          ) : (
            <CircleNotchIcon size={14} />
          )}
          {t('bridge.test')}
        </button>
      </div>

      {/* Test Result */}
      {testResult && (
        <div className={`mb-6 p-3 rounded-lg ${
          testResult.success
            ? 'bg-green-500/10 border border-green-500/30'
            : 'bg-red-500/10 border border-red-500/30'
        }`}>
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <CheckCircleIcon size={16} className="text-green-500 shrink-0" />
            ) : (
              <XCircleIcon size={16} className="text-destructive shrink-0" />
            )}
            <div>
              <p className={`text-sm font-medium ${testResult.success ? 'text-green-500' : 'text-destructive'}`}>
                {testResult.message}
              </p>
              {testResult.details && (
                <p className="text-xs text-muted-foreground mt-0.5">{testResult.details}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Content - Always visible */}
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function keyToChannel(key: string): string | null {
  const map: Record<string, string> = {
    'bridge_telegram_enabled': 'telegram',
    'bridge_qq_enabled': 'qq',
    'bridge_weixin_enabled': 'weixin',
    'bridge_feishu_enabled': 'feishu',
    'bridge_whatsapp_enabled': 'whatsapp',
  };
  return map[key] || null;
}

function WhatsAppSettingsPanel({
  enabled,
  running,
  onTest,
  testing,
  testResult,
  settings,
  updateSetting,
}: {
  enabled: boolean;
  running?: boolean;
  onTest: () => void;
  testing: boolean;
  testResult?: TestResult;
  settings: BridgeSettings | null;
  updateSetting: (key: string, value: string) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{t('bridge.whatsapp')}</h2>
          {enabled && running !== undefined && (
            <span
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                running
                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                  : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green-500" : "bg-yellow-500"}`} />
              {running ? t('bridge.connected') : t('bridge.disconnected')}
            </span>
          )}
        </div>
        <button
          onClick={onTest}
          disabled={testing || !enabled}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 hover:bg-muted transition-all disabled:opacity-50"
        >
          {testing ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : testResult ? (
            testResult.success ? (
              <CheckCircleIcon size={14} className="text-green-500" />
            ) : (
              <XCircleIcon size={14} className="text-destructive" />
            )
          ) : (
            <CircleNotchIcon size={14} />
          )}
          {t('bridge.test')}
        </button>
      </div>

      {/* Test Result */}
      {testResult && (
        <div className={`mb-6 p-3 rounded-lg ${
          testResult.success
            ? 'bg-green-500/10 border border-green-500/30'
            : 'bg-red-500/10 border border-red-500/30'
        }`}>
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <CheckCircleIcon size={16} className="text-green-500 shrink-0" />
            ) : (
              <XCircleIcon size={16} className="text-destructive shrink-0" />
            )}
            <div>
              <p className={`text-sm font-medium ${testResult.success ? 'text-green-500' : 'text-destructive'}`}>
                {testResult.message}
              </p>
              {testResult.details && (
                <p className="text-xs text-muted-foreground mt-0.5">{testResult.details}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Content */}
      <div className="space-y-4">
        <SettingsInput
          label="Session Path"
          description="Directory to store WhatsApp session data (persistent login)"
          value={settings?.['whatsapp_session_path'] || ''}
          onChange={(v) => updateSetting('whatsapp_session_path', v)}
          placeholder="~/.duya/whatsapp-session"
        />

        <SettingsSelectRow
          label="DM Policy"
          description="Who can send direct messages to the bot"
          value={settings?.['whatsapp_dm_policy'] || 'open'}
          onValueChange={(v) => updateSetting('whatsapp_dm_policy', v)}
          options={[
            { value: 'open', label: 'Open - All users' },
            { value: 'allowlist', label: 'Allowlist - Specific users only' },
            { value: 'disabled', label: 'Disabled' },
          ]}
        />

        <SettingsSelectRow
          label="Group Policy"
          description="Bot behavior in group chats"
          value={settings?.['whatsapp_group_policy'] || 'open'}
          onValueChange={(v) => updateSetting('whatsapp_group_policy', v)}
          options={[
            { value: 'open', label: 'Open - All groups' },
            { value: 'allowlist', label: 'Allowlist - Specific groups only' },
            { value: 'disabled', label: 'Disabled' },
          ]}
        />

        <SettingsToggle
          label="Require @mention"
          description="Only respond when bot is mentioned in groups"
          checked={settings?.['whatsapp_require_mention'] === 'true'}
          onCheckedChange={(checked) => updateSetting('whatsapp_require_mention', checked ? 'true' : 'false')}
        />

        <SettingsInput
          label="Free Response Chats"
          description="Group IDs where bot responds without mention (comma-separated)"
          value={settings?.['whatsapp_free_response_chats'] || ''}
          onChange={(v) => updateSetting('whatsapp_free_response_chats', v)}
          placeholder="group-id-1, group-id-2"
        />

        <SettingsInput
          label="Mention Patterns"
          description="Custom wake words/patterns for bot to respond (comma-separated)"
          value={settings?.['whatsapp_mention_patterns'] || ''}
          onChange={(v) => updateSetting('whatsapp_mention_patterns', v)}
          placeholder="bot, assistant, @duya"
        />

        <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground mb-2">Setup Instructions:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Enable WhatsApp and start the bridge</li>
            <li>Scan the QR code with your phone when prompted</li>
            <li>Session will be saved for automatic reconnection</li>
            <li>Configure group policies and mention settings as needed</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
