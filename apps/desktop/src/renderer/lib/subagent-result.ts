export interface ParsedSubAgentToolResult {
  agentType?: string;
  resolvedAgentType?: string;
  description?: string;
  content?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  background?: boolean;
  status?: 'running' | 'completed' | 'failed';
  error?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseSubAgentToolResult(result: string | null | undefined): ParsedSubAgentToolResult | null {
  if (!result) return null;

  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return {
      agentType: optionalString(parsed.agentType),
      resolvedAgentType: optionalString(parsed.resolvedAgentType),
      description: optionalString(parsed.description),
      content: optionalString(parsed.content),
      sessionId: optionalString(parsed.sessionId),
      agentId: optionalString(parsed.agentId),
      taskId: optionalString(parsed.taskId),
      background: parsed.background === true,
      status:
        parsed.status === 'running' || parsed.status === 'completed' || parsed.status === 'failed'
          ? parsed.status
          : undefined,
      error: optionalString(parsed.error),
    };
  } catch {
    return null;
  }
}
