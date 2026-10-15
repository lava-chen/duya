export type WidgetResponseStatus = 'pending' | 'answered' | 'dismissed';
export type CursorAgentRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

export interface CreateWidgetPendingInput {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly botAgentId: string;
  readonly prompt: string;
  readonly widgetJson: string;
  readonly createdAt: number;
}

export interface UpdateWidgetResponseInput {
  readonly messageId: string;
  readonly status: WidgetResponseStatus;
  readonly customAnswer?: string | null;
  readonly answeredAt?: number | null;
}

export interface CursorAgentRunInput {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly bcId: string;
  readonly status: CursorAgentRunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdateCursorAgentRunInput {
  readonly messageId: string;
  readonly status: CursorAgentRunStatus;
  readonly updatedAt: number;
}

export interface CreateSecretPendingInput {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly connector: string;
  readonly field: string;
  readonly createdAt: number;
}

export interface MarkSecretProvidedInput {
  readonly messageId: string;
  readonly status: 'provided' | 'dismissed';
  readonly providedAt?: number | null;
}

/** Local-only persistence for interactive message-card state. */
export interface HostLocalSendMessageStateApiV1 {
  createWidgetPending(input: CreateWidgetPendingInput): Promise<void>;
  updateWidgetResponse(input: UpdateWidgetResponseInput): Promise<void>;
  upsertCursorAgentRun(input: CursorAgentRunInput): Promise<void>;
  updateCursorAgentRun(input: UpdateCursorAgentRunInput): Promise<void>;
  createSecretPending(input: CreateSecretPendingInput): Promise<void>;
  markSecretProvided(input: MarkSecretProvidedInput): Promise<void>;
}
