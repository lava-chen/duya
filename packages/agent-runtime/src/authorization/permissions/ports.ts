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
  /**
   * Whether the user approved this connector tool for the session being
   * evaluated. The evaluator has no session dimension of its own, so the
   * IMPLEMENTATION must bind one: answering from a process-wide set would let
   * a second session running in the same process inherit the first one's
   * grant. An implementation that cannot name its session returns `false`.
   */
  isSessionApproved(toolName: string): boolean;
  renderConnectorApproval(descriptor: AppConnectionToolDescriptor, input: Record<string, unknown>): string;
  getPermissionPrescreener(): ((toolName: string, input: Record<string, unknown>) => Promise<{
    suggestion: string;
    p: number;
  } | null | undefined>) | null;
  warn(message: string, metadata?: Record<string, unknown>): void;
}
