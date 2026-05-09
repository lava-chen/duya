import type { LLMClient } from '../llm/base.js';
import type { PromptManager } from '../prompts/PromptManager.js';
import type { Message } from '../types.js';
import { buildConductorSystemPrompt } from './prompt.js';

export interface ConductorSnapshot {
  canvasId: string;
  canvasName: string;
  widgets: Array<{
    id: string;
    type: string;
    kind: string;
    position: { x: number; y: number; w: number; h: number };
    config: Record<string, unknown>;
    data: Record<string, unknown>;
    dataVersion: number;
  }>;
  actionCursor: number;
}

export interface ConductorAgentConfig {
  sessionId: string;
  promptManager: PromptManager;
  snapshot: ConductorSnapshot;
  llmClient: LLMClient;
  providerConfig: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider: 'anthropic' | 'openai' | 'ollama';
    authStyle?: 'api_key' | 'auth_token';
  };
  requestPermission: (request: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    requiresConfirmation: boolean;
  }) => Promise<'allow' | 'deny'>;
  sendToMain: (msg: Record<string, unknown>) => void;
  onInterrupt?: () => void;
}

interface ToolCallAction {
  id: string;
  action: string;
  params: Record<string, unknown>;
}

export class ConductorAgent {
  private config: ConductorAgentConfig;
  private messages: Message[] = [];
  private interrupted = false;

  constructor(config: ConductorAgentConfig) {
    this.config = config;
  }

  get sessionId(): string {
    return this.config.sessionId;
  }

  interrupt(): void {
    this.interrupted = true;
    this.config.onInterrupt?.();
  }

  async run(prompt: string): Promise<void> {
    this.interrupted = false;

    const { llmClient, sendToMain, snapshot } = this.config;
    const sessionId = this.sessionId;

    sendToMain({ type: 'conductor:status', sessionId, status: 'thinking' });

    try {
      const systemPrompt = buildConductorSystemPrompt({
        canvasId: snapshot.canvasId,
        canvasName: snapshot.canvasName,
        widgetCount: snapshot.widgets.length,
        widgets: snapshot.widgets.map((w) => ({
          id: w.id,
          type: w.type,
          data: w.data,
        })),
      });

      this.messages.push({
        role: 'user',
        content: prompt,
      });

      sendToMain({ type: 'conductor:status', sessionId, status: 'streaming' });

      const stream = llmClient.streamChat(this.messages, {
        systemPrompt,
        maxTokens: 4096,
        temperature: 0.7,
      });

      let fullResponse = '';

      for await (const event of stream) {
        if (this.interrupted) break;

        if (event.type === 'text') {
          const text = (event as { type: 'text'; data: string }).data;
          fullResponse += text;
          sendToMain({
            type: 'conductor:text',
            sessionId,
            content: text,
          });
        } else if (event.type === 'thinking') {
          const thinking = (event as { type: 'thinking'; data: string }).data;
          sendToMain({
            type: 'conductor:thinking',
            sessionId,
            content: thinking,
          });
        }
      }

      if (this.interrupted) {
        sendToMain({ type: 'conductor:done', sessionId });
        return;
      }

      const actions = this.parseActionsFromResponse(fullResponse);

      if (actions.length > 0) {
        for (const action of actions) {
          if (this.interrupted) break;

          sendToMain({
            type: 'conductor:tool_use',
            sessionId,
            id: action.id,
            name: action.action,
            input: action.params,
          });
        }
      }

      this.messages.push({
        role: 'assistant',
        content: fullResponse,
      });

      sendToMain({ type: 'conductor:done', sessionId });
    } catch (err) {
      sendToMain({
        type: 'conductor:error',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private parseActionsFromResponse(response: string): ToolCallAction[] {
    const actions: ToolCallAction[] = [];
    const actionRegex = /<action\s+type="([^"]+)"(?:\s+id="([^"]*)")?\s*>([\s\S]*?)<\/action>/g;

    let match: RegExpExecArray | null;
    while ((match = actionRegex.exec(response)) !== null) {
      const actionType = match[1];
      const actionId = match[2] || `action-${actions.length}`;
      const jsonStr = match[3].trim();

      try {
        const params = JSON.parse(jsonStr);
        actions.push({
          id: actionId,
          action: actionType,
          params,
        });
      } catch {
        this.config.sendToMain({
          type: 'conductor:error',
          sessionId: this.sessionId,
          message: `Failed to parse action JSON: ${jsonStr.slice(0, 100)}`,
        });
      }
    }

    return actions;
  }

  getMessages(): Message[] {
    return this.messages;
  }
}
