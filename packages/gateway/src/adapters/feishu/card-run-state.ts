/**
 * 飞书流式卡片的运行时状态机。
 *
 * 把 AgentStreamPayload 累积成一个结构化的 RunState,便于渲染层无时序地
 * 把它转成 CardKit 2.0 JSON。所有 reducer 是纯函数:`reduce(state, payload) → state`。
 *
 * 设计参考 Proma lib/feishu/card-run-state.ts;但消费的是 duya 的
 * AgentStreamPayload 形态(duya 内部使用)。
 */

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;

export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunStateMeta {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface RunState {
  blocks: Block[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** idle_timeout 终态下,无响应的分钟数(渲染层拼 "N 分钟无响应")。 */
  idleTimeoutMinutes?: number;
  startedAt: number;
  meta: RunStateMeta;
}

/**
 * Agent 流事件载荷。duya 内部 Agent 集成使用。
 *
 * kind 决定 payload 形态:
 * - 'sdk_message': Anthropic SDK 风格消息帧
 * - 'duya_event': duya 平台侧事件(模型解析等)
 */
export type AgentStreamPayload =
  | { kind: 'sdk_message'; message: SDKMessage }
  | { kind: 'duya_event'; event: DuyaEvent };

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | { type: string; [k: string]: unknown };

export interface SDKAssistantMessage {
  type: 'assistant';
  message?: {
    model?: string;
    content?: SDKContentBlock[];
  };
  error?: { message?: string };
}

export interface SDKUserMessage {
  type: 'user';
  message?: {
    content?: SDKContentBlock[];
  };
}

export interface SDKResultMessage {
  type: 'result';
  subtype?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
  errors?: string[];
}

export type SDKContentBlock =
  | { type: 'text'; text?: unknown }
  | { type: 'thinking'; thinking?: unknown }
  | { type: 'tool_use'; id?: unknown; name?: unknown; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
  | { type: string; [k: string]: unknown };

export type DuyaEvent =
  | { type: 'model_resolved'; model: string }
  | { type: string; [k: string]: unknown };

export function createInitialState(): RunState {
  return {
    blocks: [],
    reasoning: { content: '', active: false },
    footer: 'thinking',
    terminal: 'running',
    startedAt: Date.now(),
    meta: {},
  };
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

function appendText(state: RunState, delta: string): RunState {
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.kind === 'text' && last.streaming) {
    const next: Block = { ...last, content: last.content + delta };
    return {
      ...state,
      blocks: [...state.blocks.slice(0, -1), next],
      reasoning: { ...state.reasoning, active: false },
      footer: 'streaming',
    };
  }
  return {
    ...state,
    blocks: [...state.blocks, { kind: 'text', content: delta, streaming: true }],
    reasoning: { ...state.reasoning, active: false },
    footer: 'streaming',
  };
}

function appendThinking(state: RunState, delta: string): RunState {
  return {
    ...state,
    reasoning: { content: state.reasoning.content + delta, active: true },
    footer: 'thinking',
  };
}

function startTool(state: RunState, id: string, name: string, input: unknown): RunState {
  const tool: ToolEntry = { id, name, input, status: 'running' };
  return {
    ...state,
    blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
    reasoning: { ...state.reasoning, active: false },
    footer: 'tool_running',
  };
}

function completeTool(state: RunState, id: string, output: string, isError: boolean): RunState {
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'tool' || b.tool.id !== id) return b;
    return {
      ...b,
      tool: { ...b.tool, status: isError ? ('error' as const) : ('done' as const), output },
    };
  });
  return { ...state, blocks };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: string }).text === 'string') {
          return (c as { text: string }).text;
        }
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function reduce(state: RunState, payload: AgentStreamPayload): RunState {
  if (payload.kind === 'sdk_message') {
    const msg = payload.message;

    if (msg.type === 'assistant') {
      const am = msg as SDKAssistantMessage;
      let next = state;
      if (am.message?.model && !next.meta.model) {
        next = { ...next, meta: { ...next.meta, model: am.message.model } };
      }
      // assistant 消息上若携带顶层 error 字段,直接转为 error 终态
      if (am.error?.message) {
        return markError(state, am.error.message);
      }
      for (const block of am.message?.content ?? []) {
        if (block.type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string' && text) {
            next = appendText(next, text);
          }
        } else if (block.type === 'thinking') {
          const thinking = (block as { thinking?: unknown }).thinking;
          if (typeof thinking === 'string' && thinking) {
            next = appendThinking(next, thinking);
          }
        } else if (block.type === 'tool_use') {
          const tb = block as { id?: unknown; name?: unknown; input?: unknown };
          if (typeof tb.id === 'string' && typeof tb.name === 'string') {
            next = startTool(next, tb.id, tb.name, tb.input);
          }
        }
      }
      return next;
    }

    if (msg.type === 'user') {
      const um = msg as SDKUserMessage;
      let next = state;
      for (const block of um.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const trb = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
          if (typeof trb.tool_use_id === 'string') {
            const output = stringifyToolResult(trb.content);
            next = completeTool(next, trb.tool_use_id, output, trb.is_error === true);
          }
        }
      }
      return next;
    }

    if (msg.type === 'result') {
      const rm = msg as SDKResultMessage;
      const meta: RunStateMeta = {
        ...state.meta,
        durationMs: Date.now() - state.startedAt,
        inputTokens: rm.usage?.input_tokens,
        outputTokens: rm.usage?.output_tokens,
        costUsd: rm.total_cost_usd,
      };
      // result.subtype 以 'error' 开头视为错误(含 error / error_max_turns /
      // error_max_budget_usd / error_during_execution)
      const isError = typeof rm.subtype === 'string' && rm.subtype.startsWith('error');
      if (isError) {
        const errMsg = rm.errors?.[0] ?? rm.subtype ?? 'Agent 运行出错';
        return {
          ...state,
          blocks: closeStreamingText(state.blocks),
          reasoning: { ...state.reasoning, active: false },
          terminal: 'error',
          footer: null,
          errorMsg: errMsg,
          meta,
        };
      }
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
        meta,
      };
    }

    return state;
  }

  if (payload.kind === 'duya_event') {
    const evt = payload.event;
    if (evt.type === 'model_resolved' && typeof evt.model === 'string') {
      return { ...state, meta: { ...state.meta, model: evt.model } };
    }
    return state;
  }

  return state;
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function markError(state: RunState, message: string): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'error',
    footer: null,
    errorMsg: message,
  };
}

/** 当外部确认 run 已结束但 state 仍是 running 时,兜底收尾。 */
export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}
