"use client";

import { useState, useEffect, useCallback } from "react";
import {
  SpinnerGapIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  WarningIcon,
  ArrowUpRightIcon,
} from "@/components/icons";
import { ChannelIcon, CHANNEL_COLORS } from "./ChannelIcon";

interface AdapterHealth {
  connected: boolean;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  totalMessages: number;
  botUsername?: string;
}

interface BridgeStatus {
  running: boolean;
  adapters: Array<{
    channelType: string;
    running: boolean;
    lastMessageAt?: number;
    error?: string;
    health?: AdapterHealth;
  }>;
  autoStart: boolean;
  _orphaned?: boolean;
}

interface ChannelSettings {
  'bridge_telegram_enabled': string;
  'bridge_feishu_enabled': string;
  'bridge_qq_enabled': string;
  'bridge_weixin_enabled': string;
}

const CHANNEL_INFO: Record<
  string,
  { name: string; color: string; bgColor: string }
> = {
  telegram: {
    name: "Telegram",
    color: CHANNEL_COLORS.telegram.color,
    bgColor: CHANNEL_COLORS.telegram.bgColor,
  },
  feishu: {
    name: "Feishu",
    color: CHANNEL_COLORS.feishu.color,
    bgColor: CHANNEL_COLORS.feishu.bgColor,
  },
  qq: {
    name: "QQ Guild",
    color: CHANNEL_COLORS.qq.color,
    bgColor: CHANNEL_COLORS.qq.bgColor,
  },
  weixin: {
    name: "WeChat",
    color: CHANNEL_COLORS.weixin.color,
    bgColor: CHANNEL_COLORS.weixin.bgColor,
  },
};

const ALL_CHANNELS = ["telegram", "feishu", "qq", "weixin"];

interface ChannelStatusGridProps {
  onChannelClick?: (channel: string) => void;
}

export function ChannelStatusGrid({ onChannelClick }: ChannelStatusGridProps) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [statusData, settingsData] = await Promise.all([
        window.electronAPI?.gateway?.getStatus(),
        window.electronAPI?.settingsDb?.getAll(),
      ]);
      if (statusData) setStatus(statusData as BridgeStatus);
      if (settingsData) {
        const s = settingsData as Record<string, string>;
        setSettings({
          'bridge_telegram_enabled': s['bridge_telegram_enabled'] || 'false',
          'bridge_feishu_enabled': s['bridge_feishu_enabled'] || 'false',
          'bridge_qq_enabled': s['bridge_qq_enabled'] || 'false',
          'bridge_weixin_enabled': s['bridge_weixin_enabled'] || 'false',
        });
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-4">
        <SpinnerGapIcon size={16} className="animate-spin" />
        <span className="text-xs text-muted-foreground">Loading...</span>
      </div>
    );
  }

  const enabledChannels = ALL_CHANNELS.filter((ch) => {
    const key = `bridge_${ch}_enabled` as keyof ChannelSettings;
    return settings?.[key] === 'true';
  });

  if (enabledChannels.length === 0) {
    return (
      <div
        className="p-4 rounded-xl text-xs text-center"
        style={{ color: "var(--muted)", backgroundColor: "var(--surface)" }}
      >
        No channels configured. Click the settings icon to add channels.
      </div>
    );
  }

  const adapterMap = new Map(
    status?.adapters.map((a) => [a.channelType, a]) ?? []
  );

  const isOrphaned = status?._orphaned ?? false;

  return (
    <div className="grid grid-cols-2 gap-3">
      {enabledChannels.map((ch) => {
        const info = CHANNEL_INFO[ch] || {
          name: ch,
          color: "var(--muted)",
          bgColor: "var(--surface)",
        };
        const adapter = adapterMap.get(ch);
        const isRunning = adapter?.running ?? false;
        const isConnected = adapter?.health?.connected ?? false;
        const hasError = adapter?.error && adapter.error.length > 0;
        const botUsername = adapter?.health?.botUsername;
        const totalMessages = adapter?.health?.totalMessages ?? 0;

        let statusLabel = "Disconnected";
        let statusColor = "var(--muted)";
        let statusBg = "var(--surface)";
        let StatusIcon = CircleNotchIcon;

        if (isConnected) {
          statusLabel = "Connected";
          statusColor = "var(--success)";
          statusBg = "var(--success-soft)";
          StatusIcon = CheckCircleIcon;
        } else if (isRunning) {
          statusLabel = "Connecting...";
          statusColor = "var(--warning)";
          statusBg = "var(--warning-soft)";
          StatusIcon = CircleNotchIcon;
        } else if (hasError) {
          statusLabel = "Error";
          statusColor = "var(--error)";
          statusBg = "var(--error-soft)";
          StatusIcon = WarningIcon;
        } else if (isOrphaned) {
          statusLabel = "Active";
          statusColor = "var(--success)";
          statusBg = "var(--success-soft)";
          StatusIcon = CheckCircleIcon;
        }

        return (
          <button
            key={ch}
            onClick={() => onChannelClick?.(ch)}
            className="group relative p-4 rounded-xl text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            {/* Top row: icon + name + status */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center transition-transform duration-200 group-hover:scale-110"
                  style={{
                    backgroundColor: info.bgColor,
                    color: info.color,
                  }}
                >
                  <ChannelIcon channel={ch} size={18} />
                </div>
                <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                  {info.name}
                </span>
              </div>
              <div
                className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium"
                style={{
                  backgroundColor: statusBg,
                  color: statusColor,
                }}
              >
                <StatusIcon size={10} className={isRunning && !isConnected ? "animate-spin" : ""} />
                {statusLabel}
              </div>
            </div>

            {/* Bottom row: metadata */}
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                {botUsername && (
                  <span className="text-[11px] font-medium" style={{ color: "var(--muted)" }}>
                    @{botUsername}
                  </span>
                )}
                <span className="text-[10px]" style={{ color: "var(--muted)" }}>
                  {totalMessages} messages
                </span>
              </div>
              <ArrowUpRightIcon
                size={14}
                className="opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                style={{ color: "var(--muted)" }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
