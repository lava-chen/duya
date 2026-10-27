import type { ToolUseContext } from '../contracts/tool.js';

export interface SendMessageContext extends ToolUseContext {
  options?: ToolUseContext['options'] & {
    agentProfileId?: string | null;
  };
}

export interface SendMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  status: string;
  msg_type: string;
  source: string;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface SendMessageChannelActivity {
  id: string;
  sessionId: string;
  channel: string;
  content: string;
  mediaUrl?: string;
}

export interface SendMessagePort {
  appendMessage(sessionId: string, messages: readonly SendMessageRow[]): Promise<unknown>;
  createWidgetPending(input: {
    id: string;
    messageId: string;
    sessionId: string;
    botAgentId: string;
    prompt: string;
    widgetJson: string;
    createdAt: number;
  }): Promise<unknown>;
  upsertCursorAgentRun(input: {
    id: string;
    messageId: string;
    sessionId: string;
    bcId: string;
    status: 'pending';
    createdAt: number;
    updatedAt: number;
  }): Promise<unknown>;
  createSecretPending(input: {
    id: string;
    messageId: string;
    sessionId: string;
    label: string;
    connector: string;
    field: string;
    createdAt: number;
  }): Promise<unknown>;
  deliverToChannel(input: {
    sessionId: string;
    channel: string;
    content: string;
    mediaUrl?: string;
    mediaAlt?: string;
  }): Promise<{ success?: boolean; reason?: string; queued?: boolean; deliveryId?: string } | undefined>;
  appendChannelActivity(input: SendMessageChannelActivity): Promise<unknown>;
  logError(message: string, error: Error, context: Record<string, unknown>, component: string): void;
  logDebug(message: string, context: Record<string, unknown>): void;
}
