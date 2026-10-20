import type { HostAppConnectionStatus } from "@duya/agent-protocol";
import type { AppConnectorId } from "@duya/connectors/app-connector-id";

export type ProviderId = AppConnectorId;
export type AppConnectionStatus = HostAppConnectionStatus;

export interface AppConnectionStatusDTO {
  id: string;
  provider: ProviderId;
  accountLabel: string;
  accountId: string;
  scopes: string[];
  status: AppConnectionStatus;
  expiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  connectionSlug?: string;
  ledger?: {
    discoveryStatus: "complete" | "refreshing" | "failed" | "stale";
    pagesFetched: number;
    discoveredTotal: number;
    inventoryRevision: number;
    layers: {
      discovered: number;
      descriptors: number;
      aliases: number;
      registered: number;
      discoverable: number;
    };
    fetchedAt: number;
  };
}

export interface AppConnectionProviderDTO {
  id: ProviderId;
  label: string;
  configured: boolean;
  configurationHint?: string;
  supportsManualConfiguration: boolean;
  requiresClientSecret: boolean;
  monogram: string;
  description: string;
  scopes?: string[];
}
