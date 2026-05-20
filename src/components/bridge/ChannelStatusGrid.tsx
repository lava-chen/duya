"use client";

import { useState, useEffect, useCallback } from "react";
import {
  SpinnerGapIcon,
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
    displayConfig?: {
      streaming: boolean | null;
      toolProgress: 'all' | 'new' | 'off';
      showReasoning: boolean;
    };
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
  selectedChannel?: string | null;
}

export function ChannelStatusGrid({ onChannelClick, selectedChannel }: ChannelStatusGridProps) {
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
        className="py-6 text-xs text-center"
        style={{ color: "var(--muted)" }}
      >
        No channels configured
      </div>
    );
  }

  const adapterMap = new Map(
    status?.adapters.map((a) => [a.channelType, a]) ?? []
  );

  return (
    <div className="channel-sidebar">
      {enabledChannels.map((ch) => {
        const info = CHANNEL_INFO[ch] || {
          name: ch,
          color: "var(--muted)",
          bgColor: "var(--surface)",
        };
        const adapter = adapterMap.get(ch);
        const isConnected = adapter?.health?.connected ?? false;
        const isRunning = adapter?.running ?? false;
        const displayConfig = adapter?.displayConfig;
        const totalMessages = adapter?.health?.totalMessages ?? 0;

        // Determine status color
        let statusColor = "#ef4444"; // Red (disconnected/error)
        if (isConnected) {
          statusColor = "#22c55e"; // Green (connected)
        } else if (isRunning) {
          statusColor = "#f59e0b"; // Yellow (connecting)
        }

        const tooltipParts: string[] = [info.name];
        if (displayConfig) {
          const features: string[] = [];
          if (displayConfig.streaming === false) features.push('no-stream');
          if (displayConfig.toolProgress === 'off') features.push('no-tools');
          if (displayConfig.toolProgress === 'new') features.push('tools-new');
          if (displayConfig.showReasoning) features.push('reasoning');
          if (features.length > 0) tooltipParts.push(`(${features.join(',')})`);
        }
        if (isConnected) tooltipParts.push(`msgs:${totalMessages}`);
        if (!isConnected && isRunning) tooltipParts.push('connecting...');
        if (adapter?.error) tooltipParts.push(`err:${adapter.error.slice(0, 30)}`);

        const isSelected = selectedChannel === ch;
        return (
          <button
            key={ch}
            onClick={() => onChannelClick?.(ch)}
            className={`channel-sidebar-item ${isSelected ? "selected" : ""}`}
            title={tooltipParts.join(' ')}
          >
            <div
              className="channel-sidebar-icon"
              style={{
                backgroundColor: info.bgColor,
                color: info.color,
              }}
            >
              <ChannelIcon channel={ch} size={22} />
            </div>
            <span
              className="channel-sidebar-status-dot"
              style={{ backgroundColor: statusColor }}
            />
          </button>
        );
      })}
    </div>
  );
}
