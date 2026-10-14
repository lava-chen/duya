import type { ToolUseContext } from '../contracts/tool.js';

export type AppConnectionRiskTier = 'read' | 'draft' | 'write' | 'modify' | 'destructive';

/** Canonical descriptor DTO returned by the Host-owned connector broker. */
export interface AppConnectionToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  inputSchemaSummary: string;
  riskTier: AppConnectionRiskTier;
  tierSource?: 'annotations' | 'fallback';
  title?: string;
  /** Host-derived global approval projection; capabilities never persist grants. */
  preApproved?: boolean;
  provider: string;
  providerLabel?: string;
  connectionId: string;
  connectionSlug?: string;
  action: string;
}

export interface AppConnectionInvokeRequest {
  connectionId: string;
  action: string;
  args: Record<string, unknown>;
  deadlineAt: number;
}

export interface AppConnectionInvokeResponse {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; [key: string]: unknown };
}

export interface ConnectorReauthorizationRequest {
  sessionId?: string;
  toolName: string;
  provider: string;
  connectionId: string;
  variant: 'reauth';
}

/** Narrow runtime bridge; transport and credentials remain Host-owned. */
export interface AppConnectionInvokePort {
  invoke(
    request: AppConnectionInvokeRequest,
    options: { timeout: number },
  ): Promise<AppConnectionInvokeResponse>;
  requestReauthorization?(request: ConnectorReauthorizationRequest): void;
}

export interface AppConnectionToolContext extends ToolUseContext {
  appConnection?: AppConnectionInvokePort;
}

export interface ConnectorToolMetaInput {
  exposure?: 'eager' | 'deferred' | 'hidden';
  inputSchemaSummary?: string;
  catalogInputSchema?: Record<string, unknown>;
  catalogDescription?: string;
  discovery?: {
    namespace?: string;
    conciseHint?: string;
    tags?: string[];
  };
  source?: { kind: 'builtin' | 'mcp' | 'plugin' | 'connector'; id: string };
  riskTier?: AppConnectionRiskTier;
}

export interface ConnectorReplaceSetResult {
  removedKeys: string[];
  addedKeys: string[];
  keptKeys: string[];
}

export interface AppConnectionToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Structural projection of the runtime registry used by connector discovery. */
export interface ConnectorReplaceSetPort<TExecutor> {
  replaceByOwner(
    ownerId: `connector:${string}`,
    preparedEntries: ReadonlyArray<{
      key: string;
      definition: AppConnectionToolDefinition;
      executor: TExecutor;
      meta?: ConnectorToolMetaInput;
    }>,
  ): ConnectorReplaceSetResult;
}

export type AppConnectionToolExecutor = {
  execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: AppConnectionToolContext,
  ): Promise<import('../contracts/tool.js').ToolResult>;
};
