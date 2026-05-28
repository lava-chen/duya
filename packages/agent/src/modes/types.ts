import type { LLMClient } from '../llm/base.js';
import type { SSEEvent } from '../types.js';
import type { LiteraturePluginRuntime } from '../plugins/literature/types.js';
import type { ResearchMemoryRuntime } from '../research-memory/types.js';
import type { ToolResult } from '../tool/types.js';

export type { SSEEvent };

export interface ClarificationQuestion {
  id: string;
  question: string;
  type: 'single_choice' | 'multi_choice' | 'free_text';
  options?: string[];
}

export interface ClarificationAnswer {
  questionId: string;
  answer: string | string[];
}

export interface ModeContext {
  llmClient: LLMClient;
  abortController: AbortController;
  sessionId?: string;
  workingDirectory?: string;
  emitSSE?: (event: SSEEvent) => void;
  awaitClarification?: (
    questions: ClarificationQuestion[]
  ) => Promise<ClarificationAnswer[]>;
  persistState?: (data: Record<string, unknown>) => Promise<void>;
  literature?: LiteraturePluginRuntime;
  researchMemory?: ResearchMemoryRuntime;
  toolExecute?: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  toolExecuteConcurrent?: (
    calls: Array<{ name: string; input: Record<string, unknown> }>
  ) => AsyncGenerator<ToolResult>;
  forwardSSE?: (event: SSEEvent) => void;
}

export abstract class BaseMode {
  abstract readonly name: string;
  abstract readonly modeId: string;

  abstract execute(
    query: string,
    ctx: ModeContext
  ): AsyncGenerator<SSEEvent, void, unknown>;

  handleUserInput?(input: unknown): Promise<void>;

  abort(): void {}

  serialize(): Record<string, unknown> {
    return {};
  }

  deserialize(_data: Record<string, unknown>): void {}
}

export type ModeConstructor = new () => BaseMode;