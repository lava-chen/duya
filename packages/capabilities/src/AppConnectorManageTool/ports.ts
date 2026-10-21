import type { ToolUseContext } from '../contracts/tool.js';

export interface AppConnectorProviderDTO {
  id: string;
  label: string;
  configured: boolean;
  configurationHint?: string;
  supportsManualConfiguration?: boolean;
  description?: string;
  scopes?: string[];
}

export interface AppConnectorConnectionDTO {
  id: string;
  provider: string;
  accountLabel?: string;
  status: string;
  lastError?: string | null;
}

export interface AppConnectorCatalogDTO {
  providers: AppConnectorProviderDTO[];
  connections: AppConnectorConnectionDTO[];
}

export interface AppConnectorCatalogResponse {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface AppConnectorAuthRequest {
  sessionId?: string;
  toolName: string;
  provider: string;
  variant: 'connect';
}

/** Host-owned catalog and chat-event bridge; contains no credentials/grants. */
export interface AppConnectorManagementPorts {
  getCatalog(): Promise<AppConnectorCatalogResponse>;
  requestAuthorization?(request: AppConnectorAuthRequest): void;
}

export interface AppConnectorManagementContext extends ToolUseContext {
  appConnectorManagement?: AppConnectorManagementPorts;
}
