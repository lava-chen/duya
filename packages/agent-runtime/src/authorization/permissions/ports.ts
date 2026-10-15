import type { AppConnectionToolDescriptor } from '@duya/capabilities/AppConnectionTool';
import type { Message } from '@duya/agent-protocol/transcript';

/** Runtime requests advisory classification; Host supplies the provider client. */
export interface PermissionClassifierClient {
  chat?(messages: Message[], options?: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{
    content: string;
    usage?: { input_tokens: number; output_tokens: number; cache_hit_tokens?: number; cache_creation_tokens?: number };
  }>;
}

/** Host binds durable grants and optional advisory classifiers to the evaluator. */
export interface PermissionEvaluationPorts {
  getConnectorDescriptors(): readonly AppConnectionToolDescriptor[];
  isSessionApproved(toolName: string): boolean;
  renderConnectorApproval(descriptor: AppConnectionToolDescriptor, input: Record<string, unknown>): string;
  getPermissionPrescreener(): ((toolName: string, input: Record<string, unknown>) => Promise<{
    suggestion: string;
    p: number;
  } | null | undefined>) | null;
  warn(message: string, metadata?: Record<string, unknown>): void;
}
