import type { ProviderId } from "@/lib/app-connection-ipc";

export interface ConnectorPreset {
  provider: ProviderId;
  name: string;
  description: string;
  monogram: string;
  scopes: string[];
}

export const OFFICIAL_CONNECTORS: ConnectorPreset[] = [
  {
    provider: "google" as ProviderId,
    name: "Google",
    description: "连接 Google Drive、Gmail 和 Calendar，让 Agent 代为读取和起草内容。",
    monogram: "G",
    scopes: [],
  },
  {
    provider: "slack" as ProviderId,
    name: "Slack",
    description: "连接 Slack，让 Agent 搜索频道并发送消息。",
    monogram: "S",
    scopes: [],
  },
  {
    provider: "microsoft365" as ProviderId,
    name: "Microsoft 365",
    description: "连接 Microsoft 365，让 Agent 访问 OneDrive、Outlook 和 Teams。",
    monogram: "M",
    scopes: [],
  },
];
