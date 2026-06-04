/**
 * RunState → CardKit 2.0 卡片 JSON 的纯函数渲染器。
 *
 * 设计要点:
 * - streaming_mode 标志告诉飞书客户端这是动态卡(终态时关闭动效)
 * - 工具调用 >= COLLAPSE_TOOL_THRESHOLD 时合并为单面板,避免每个 element
 *   超过飞书 30KB 的限制(长 tool_result 很容易撞)
 * - 工具调用面板默认收起,手机端只保留清晰的运行状态和摘要
 * - 底部 summary 是手机端通知预览的短文本
 *
 * 设计参考 Proma lib/feishu/card-renderer-v2.ts。
 */

import type { Block, FooterStatus, RunState, ToolEntry } from './card-run-state.js';

const REASONING_MAX = 1500;
/** 工具调用数量 >= 这个值时,折叠成单个摘要面板。 */
const MIN_TOOLS_TO_COLLAPSE = 3;
const TOOL_BODY_MAX = 4000;
const TEXT_BLOCK_MAX = 20_000;

export interface RenderOptions {
  /** 卡片底部"如何终止"的提示文字。running 终态时展示。 */
  stopHint?: string;
  /** 是否展示工具调用块(Bot 偏好里可关)。默认 true。 */
  showToolCalls?: boolean;
  /** 卡片头部小标题,例如 "@xxx Bot · 工作区 yyy"。 */
  header?: string;
}

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}

interface TextGroup {
  kind: 'text';
  content: string;
}

type Group = ToolGroup | TextGroup;

export function renderCard(state: RunState, opts: RenderOptions = {}): object {
  const showToolCalls = opts.showToolCalls !== false;
  const elements: object[] = [];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  const visibleBlocks = showToolCalls
    ? state.blocks
    : state.blocks.filter((b) => b.kind !== 'tool');

  for (const group of groupBlocks(visibleBlocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(truncate(group.content, TEXT_BLOCK_MAX)));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`Agent 失败:${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_(Agent 未返回内容)_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer, state.blocks));
    if (opts.stopHint) elements.push(noteMd(opts.stopHint));
  } else {
    elements.push(metaFooter(state));
  }

  const card: Record<string, unknown> = {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };

  if (opts.header) {
    card.header = {
      title: { tag: 'plain_text', content: opts.header },
      template: state.terminal === 'error'
        ? 'red'
        : state.terminal === 'running' ? 'blue' : 'default',
    };
  }

  return card;
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < MIN_TOOLS_TO_COLLAPSE) {
    return tools.map((t) => toolPanel(t, finalized));
  }
  return [toolGroupPanel(tools, finalized)];
}

function reasoningPanel(content: string, active: boolean): object {
  const truncated = truncate(content, REASONING_MAX);
  return {
    tag: 'collapsible_panel',
    expanded: active,
    header: {
      title: { tag: 'plain_text', content: active ? '正在思考…' : '思考过程' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: truncated },
      },
    ],
  };
}

function toolPanel(tool: ToolEntry, finalized: boolean): object {
  const status = tool.status === 'done' ? '✅'
    : tool.status === 'error' ? '❌'
    : '⏳';
  const inputStr = tool.input !== undefined ? truncate(JSON.stringify(tool.input, null, 2), 600) : '';
  const outputStr = tool.output !== undefined ? truncate(tool.output, TOOL_BODY_MAX) : '';

  const elements: object[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${status} ${tool.name}**` },
    },
  ];
  if (inputStr) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `_输入_\n\`\`\`\n${inputStr}\n\`\`\`` },
    });
  }
  if (finalized && outputStr) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `_输出_\n\`\`\`\n${outputStr}\n\`\`\`` },
    });
  }

  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: `${status} ${tool.name}` },
    },
    elements,
  };
}

function toolGroupPanel(tools: ToolEntry[], finalized: boolean): object {
  const summary = tools
    .map((t) => {
      const mark = t.status === 'done' ? '✅'
        : t.status === 'error' ? '❌'
        : '⏳';
      return `${mark} ${t.name}`;
    })
    .join('\n');
  const totalOutput = tools
    .filter((t) => t.output)
    .map((t) => `### ${t.name}\n${truncate(t.output!, 1500)}`)
    .join('\n\n');
  const elements: object[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**${tools.length} 个工具调用**\n${summary}` },
    },
  ];
  if (finalized && totalOutput) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: totalOutput },
    });
  }
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: `${tools.length} 个工具调用(已折叠)` },
    },
    elements,
  };
}

function footerStatus(footer: FooterStatus, blocks: Block[]): object {
  const toolsRunning = blocks.some((b) => b.kind === 'tool' && b.tool.status === 'running');
  const text = footer === 'thinking' ? '正在思考…'
    : footer === 'tool_running' ? `正在执行工具(已完成 ${blocks.filter((b) => b.kind === 'tool' && b.tool.status === 'done').length} 个)`
    : footer === 'streaming' ? '正在输出…'
    : toolsRunning ? '正在执行工具…' : '处理中…';
  return noteMd(text);
}

function metaFooter(state: RunState): object {
  const m = state.meta;
  const parts: string[] = [];
  if (m.model) parts.push(m.model);
  if (m.durationMs != null) parts.push(formatDuration(m.durationMs));
  if (m.inputTokens != null || m.outputTokens != null) {
    const inT = m.inputTokens ?? 0;
    const outT = m.outputTokens ?? 0;
    parts.push(`${inT} → ${outT} tok`);
  }
  if (m.costUsd != null) parts.push(`$${m.costUsd.toFixed(4)}`);
  if (parts.length === 0) return noteMd('已完成');
  return noteMd(`**完成** · ${parts.join(' · ')}`);
}

function noteMd(text: string): object {
  return {
    tag: 'note',
    elements: [{ tag: 'plain_text', content: text }],
  };
}

function markdown(content: string): object {
  return {
    tag: 'div',
    text: { tag: 'lark_md', content },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(已截断 ${s.length - max} 字符)`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function summaryText(state: RunState): string {
  if (state.terminal === 'running') return 'Agent 处理中…';
  if (state.terminal === 'interrupted') return '已被中断';
  if (state.terminal === 'error') return `失败:${state.errorMsg ?? '未知错误'}`;
  if (state.terminal === 'idle_timeout') {
    return `${state.idleTimeoutMinutes ?? 0} 分钟无响应`;
  }
  // done
  const lastText = [...state.blocks].reverse().find((b) => b.kind === 'text');
  if (lastText && lastText.kind === 'text') {
    const snippet = lastText.content.replace(/\s+/g, ' ').trim();
    return snippet.length > 60 ? `${snippet.slice(0, 57)}…` : snippet;
  }
  return '已完成';
}
