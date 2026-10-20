/**
 * Info-category executors: help / status / cost / context / transcript /
 * usage / skills.
 *
 * All of them return `{ type: 'text' }` (rendered by CommandResultDialog)
 * except `/help` and `/recap`, which have their own shapes. They read state
 * the same way the chat UI does, but without React:
 *   - session facts come from the CommandAppBridge snapshot,
 *   - messages come from `useConversationStore.getState()`,
 *   - live token frames come from `useContextUsageStore.getState()`,
 *   - pricing comes from the model capability service, falling back to the
 *     built-in @duya/ai catalog.
 *
 * Token accounting mirrors `useContextUsage` / `context-usage-utils`:
 * cached tokens are never counted twice, and a cost figure is only printed
 * when real pricing for the model is known — no rate guesswork.
 */

import type { CommandExecutorFn } from './registry';
import { getCommandsForPlatform } from '../registry';
import type { CommandContext } from '../types';
import type { Message } from '@/types/message';
import { useConversationStore } from '@/stores/conversation-store';
import { useContextUsageStore, type LiveContextUsage } from '@/stores/context-usage-store';
import {
  estimateCost,
  onlyNewInputTokens,
  formatTokensPi,
  type ModelPricing,
} from '@/lib/context-usage-utils';
import { modelCapabilityService } from '@/lib/providers/models/ModelCapabilityService';
import { computeContextEstimate, findModelById, resolveContextWindow } from '@duya/ai';

function helpText(): string {
  const byCategory = getCommandsForPlatform('app');
  const groups = new Map<string, string[]>();
  for (const cmd of byCategory) {
    const alias = cmd.aliases?.length ? ` (/${cmd.aliases.join(', /')})` : '';
    const args = cmd.argsHint ? ` ${cmd.argsHint}` : '';
    const desc = cmd.descriptionZh ?? cmd.description;
    const line = `/${cmd.name}${args}${alias} — ${desc}`;
    const list = groups.get(cmd.category) ?? [];
    list.push(line);
    groups.set(cmd.category, list);
  }
  const order = ['session', 'config', 'info', 'tools', 'exit'];
  const lines: string[] = ['可用命令 / Available commands:', ''];
  for (const category of order) {
    const list = groups.get(category);
    if (!list?.length) continue;
    lines.push(`[${category}]`);
    lines.push(...list.map((l) => `  ${l}`));
    lines.push('');
  }
  lines.push('输入 ! 开头可直接执行 shell 命令（如 !ls）。');
  lines.push('未知的 /command 会作为普通消息发送给 agent。');
  return lines.join('\n');
}

// ============================================================================
// Shared read helpers
// ============================================================================

interface SessionFacts {
  sessionId?: string;
  /** Session model; may carry the `[Provider] ` prefix the selector uses. */
  model?: string;
  effort?: string;
  permissionMode?: 'ask' | 'auto' | 'bypass';
  workingDirectory?: string | null;
  messages: Message[];
}

/** Composer snapshot + store messages, without subscribing to anything. */
function readSessionFacts(ctx: CommandContext): SessionFacts {
  const snapshot = ctx.app?.getSessionSnapshot() ?? {};
  const store = useConversationStore.getState();
  const sessionId = snapshot.sessionId ?? store.activeThreadId ?? undefined;
  return {
    sessionId,
    model: snapshot.model,
    effort: snapshot.effort,
    permissionMode: snapshot.permissionMode,
    workingDirectory: snapshot.workingDirectory,
    messages: (sessionId ? store.messages[sessionId] : undefined) ?? [],
  };
}

/** Strip the selector's `[Provider] ` prefix to get the raw model id. */
function rawModelId(model?: string): string | undefined {
  if (!model) return undefined;
  const match = model.match(/^\[([^\]]+)\]\s*(.+)$/);
  return (match ? match[2] : model).replace(/^"|"$/g, '').trim() || undefined;
}

/** Live worker frame for the session, when one is anchored to real usage. */
function readLiveUsage(sessionId?: string): LiveContextUsage | undefined {
  if (!sessionId) return undefined;
  const live = useContextUsageStore.getState().liveBySession[sessionId];
  return live && live.anchored && live.usedTokens > 0 ? live : undefined;
}

/**
 * Pricing for the session model: provider capability row first (the user
 * pinned rates / model sync), built-in catalog second. Returns undefined
 * when neither knows — the caller then omits the cost instead of guessing.
 */
function resolvePricing(
  rawModel: string | undefined,
  providerId?: string,
): ModelPricing | undefined {
  if (rawModel && providerId) {
    const cap = modelCapabilityService.getModelCapability(providerId, rawModel);
    if (cap?.pricing) {
      const { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion } = cap.pricing;
      return { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion };
    }
  }
  if (rawModel) {
    const builtIn = findModelById(rawModel);
    if (builtIn?.cost) {
      return {
        inputPerMillion: builtIn.cost.input,
        outputPerMillion: builtIn.cost.output,
        cacheReadPerMillion: builtIn.cost.cacheRead,
        cacheWritePerMillion: builtIn.cost.cacheWrite,
      };
    }
  }
  return undefined;
}

/** Per-message pricing, so a mid-session model switch is not mispriced. */
function pricingForMessage(
  messageModel: string | null | undefined,
  sessionModel: string | undefined,
  sessionPricing: ModelPricing | undefined,
): ModelPricing | undefined {
  if (!messageModel || messageModel === sessionModel) return sessionPricing;
  const cost = findModelById(messageModel)?.cost;
  if (!cost) return undefined;
  return {
    inputPerMillion: cost.input,
    outputPerMillion: cost.output,
    cacheReadPerMillion: cost.cacheRead,
    cacheWritePerMillion: cost.cacheWrite,
  };
}

interface TokenTotals {
  source: 'live' | 'scan' | 'none';
  totalInput: number;
  totalInputRaw: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  cost: number;
  /** False when no pricing is known for any contributing message. */
  costKnown: boolean;
  model?: string;
}

/**
 * Session-cumulative token totals.
 *
 * Prefers the live worker frame (its totals already cover the current
 * turn); otherwise scans persisted `tokenUsage` blocks the same way
 * `useContextUsage` does. `costKnown` is false as soon as no contributing
 * message had pricing — a partial cost would read as a real total.
 */
function readTokenTotals(
  facts: SessionFacts,
  live: LiveContextUsage | undefined,
  pricing: ModelPricing | undefined,
): TokenTotals {
  const sessionModel = rawModelId(facts.model);

  let totalInput = 0;
  let totalInputRaw = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let cost = 0;
  let pricedMessages = 0;

  if (live) {
    totalInput = live.totalInput ?? 0;
    totalInputRaw = live.totalInputRaw ?? 0;
    totalOutput = live.totalOutput ?? 0;
    totalCacheRead = live.totalCacheHit ?? 0;
    totalCacheWrite = live.totalCacheCreation ?? 0;
    cost = estimateCost(totalInputRaw, totalOutput, totalCacheRead, totalCacheWrite, pricing);
    return {
      source: 'live',
      totalInput,
      totalInputRaw,
      totalOutput,
      totalCacheRead,
      totalCacheWrite,
      cost,
      costKnown: !!pricing && (totalInputRaw > 0 || totalOutput > 0),
      model: live.model ?? sessionModel,
    };
  }

  for (const msg of facts.messages) {
    if (msg.role !== 'assistant' || !msg.tokenUsage) continue;
    const rawInput = msg.tokenUsage.input_tokens || 0;
    const output = msg.tokenUsage.output_tokens || 0;
    const cacheRead = msg.tokenUsage.cache_hit_tokens || 0;
    const cacheWrite = msg.tokenUsage.cache_creation_tokens || 0;
    totalInput += onlyNewInputTokens(rawInput, cacheRead, cacheWrite);
    totalInputRaw += rawInput;
    totalOutput += output;
    totalCacheRead += cacheRead;
    totalCacheWrite += cacheWrite;
    const msgPricing = pricingForMessage(msg.model, sessionModel, pricing);
    if (msgPricing && (rawInput > 0 || output > 0)) pricedMessages += 1;
    cost += estimateCost(rawInput, output, cacheRead, cacheWrite, msgPricing);
  }

  const hasTokens = totalInputRaw > 0 || totalOutput > 0 || totalCacheRead > 0;
  return {
    source: hasTokens ? 'scan' : 'none',
    totalInput,
    totalInputRaw,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    cost,
    costKnown: pricedMessages > 0,
    model: sessionModel,
  };
}

interface ContextReport {
  /** null = no anchor anywhere (ring shows "?"). */
  used: number | null;
  contextWindow: number;
  windowSource: 'capability' | 'catalog' | 'default';
  anchorSource: 'live' | 'scan' | 'none';
}

/**
 * Used tokens vs the model's window.
 *
 * Live frame first (its window came from the worker's own resolution chain
 * — the same chain auto-compaction budgets against), then the shared
 * estimator over persisted messages, then nothing.
 */
function readContextReport(facts: SessionFacts, live: LiveContextUsage | undefined): ContextReport {
  const sessionModel = rawModelId(facts.model);
  const liveWindow = live?.contextSnapshot?.contextWindow || live?.contextWindow || 0;
  const liveWindowSource =
    live?.contextSnapshot?.windowSource || live?.windowSource || undefined;

  if (live) {
    // The worker's frame already carries the window its own compaction
    // budgeted against — prefer it over any renderer-side resolution.
    const resolved: { contextWindow: number; windowSource: ContextReport['windowSource'] } = liveWindow
      ? { contextWindow: liveWindow, windowSource: liveWindowSource ?? 'capability' }
      : (() => {
          const fallback = resolveContextWindow({ modelId: live.model ?? sessionModel });
          return { contextWindow: fallback.contextWindow, windowSource: fallback.source };
        })();
    return {
      used:
        live.contextSnapshot?.accounting.projectedNextInputTokens ??
        live.currentEstimatedInputTokens ??
        live.usedTokens,
      contextWindow: resolved.contextWindow,
      windowSource: resolved.windowSource,
      anchorSource: 'live',
    };
  }

  const estimate = computeContextEstimate(
    facts.messages.map((m) => ({
      role: m.role,
      content: m.content as string | unknown[],
      tokenUsage: m.tokenUsage ?? undefined,
      model: m.model ?? undefined,
    })),
  );
  const resolved = resolveContextWindow({ modelId: estimate.anchorModel || sessionModel });
  return {
    used: estimate.anchored && (estimate.usedTokens ?? 0) > 0 ? estimate.usedTokens : null,
    contextWindow: resolved.contextWindow,
    windowSource: resolved.source,
    anchorSource: estimate.anchored && (estimate.usedTokens ?? 0) > 0 ? 'scan' : 'none',
  };
}

const WINDOW_SOURCE_LABELS: Record<ContextReport['windowSource'], string> = {
  capability: '模型能力（capability）',
  catalog: '内置模型目录（catalog）',
  default: '默认值 200K（未匹配到该模型的窗口）',
};

const SKILL_SOURCE_LABELS: Record<string, string> = {
  user: '用户',
  project: '项目',
  plugin: '插件',
  custom: '自定义路径',
  bundled: '内置',
};

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

// ============================================================================
// Executors
// ============================================================================

export const INFO_EXECUTORS: Record<string, CommandExecutorFn> = {
  help: () => ({ type: 'text', content: helpText() }),

  recap: async (ctx) => {
    const result = await ctx.app!.requestRecap();
    if (result.success && result.recap) {
      return { type: 'text', content: result.recap };
    }
    return { type: 'error', message: result.error ?? '无法生成对话回顾。' };
  },

  /** Session status: id, model, effort, permission mode, cwd, message count. */
  status: (ctx) => {
    const facts = readSessionFacts(ctx);
    const messageCount = facts.messages.length;
    return {
      type: 'text',
      content: [
        '会话状态 / Session status',
        '',
        `  会话 ID    ${facts.sessionId ?? '（尚未开始）'}`,
        `  模型       ${facts.model ?? '（未设置）'}`,
        `  推理程度   ${facts.effort ?? '（默认）'}`,
        `  权限模式   ${facts.permissionMode ?? '未知'}`,
        `  工作目录   ${facts.workingDirectory || '（未设置）'}`,
        `  消息数     ${messageCount}`,
      ].join('\n'),
    };
  },

  /** Token usage + cost (cost only when the model's pricing is known). */
  cost: (ctx) => {
    const facts = readSessionFacts(ctx);
    const live = readLiveUsage(facts.sessionId);
    const model = rawModelId(facts.model);
    const pricing = resolvePricing(model, live?.providerId);
    const totals = readTokenTotals(facts, live, pricing);

    if (totals.source === 'none') {
      return {
        type: 'text',
        content: [
          'Token 用量 / Token usage',
          '',
          '  本会话尚无用量记录（完成一轮回答后可用）。',
        ].join('\n'),
      };
    }

    const lines = [
      'Token 用量 / Token usage',
      '',
      `  输入（不含缓存）  ${formatTokensPi(totals.totalInput)}`,
      `  输入（原始）      ${formatTokensPi(totals.totalInputRaw)}`,
      `  缓存读取          ${formatTokensPi(totals.totalCacheRead)}`,
      `  缓存写入          ${formatTokensPi(totals.totalCacheWrite)}`,
      `  输出              ${formatTokensPi(totals.totalOutput)}`,
      '',
      totals.costKnown
        ? `  估算费用          $${totals.cost.toFixed(4)}`
        : `  估算费用          不可用（${totals.model ?? '当前模型'} 的定价未知）`,
      '',
      `  统计口径：${totals.source === 'live' ? '本轮实时数据' : '历史消息累计'}`,
    ];
    return { type: 'text', content: lines.join('\n') };
  },

  /** Alias entry — dispatch resolves `/usage` to the canonical `cost`. */
  usage: (ctx) => INFO_EXECUTORS.cost(ctx),

  /** Context window usage: used tokens vs the model's window + ratio. */
  context: (ctx) => {
    const facts = readSessionFacts(ctx);
    const live = readLiveUsage(facts.sessionId);
    const report = readContextReport(facts, live);
    const remaining = Math.max(0, report.contextWindow - (report.used ?? 0));

    const lines = ['上下文用量 / Context window', ''];
    if (report.used === null) {
      lines.push('  尚无锚定的用量数据（完成一轮回答后可用）。');
    } else {
      const ratio = report.contextWindow > 0 ? report.used / report.contextWindow : 0;
      lines.push(
        `  已用     ${formatTokensPi(report.used)} / ${formatTokensPi(report.contextWindow)}  (${percent(ratio)})`,
        `  剩余     ${formatTokensPi(remaining)}`,
      );
    }
    lines.push(
      `  窗口     ${formatTokensPi(report.contextWindow)} — ${WINDOW_SOURCE_LABELS[report.windowSource]}`,
      `  数据源   ${report.anchorSource === 'live' ? '本轮实时数据' : report.anchorSource === 'scan' ? '历史消息累计' : '无'}`,
    );
    return { type: 'text', content: lines.join('\n') };
  },

  /** Message counts by role + a pointer at the desktop export command. */
  transcript: (ctx) => {
    const facts = readSessionFacts(ctx);
    const counts = new Map<string, number>();
    for (const msg of facts.messages) {
      counts.set(msg.role, (counts.get(msg.role) ?? 0) + 1);
    }
    const ROLE_LABELS: Record<string, string> = {
      user: '用户',
      assistant: '助手',
      tool: '工具结果',
      system: '系统',
    };

    if (facts.messages.length === 0) {
      return {
        type: 'text',
        content: ['转录统计 / Transcript', '', '  当前会话没有消息。'].join('\n'),
      };
    }

    const lines = ['转录统计 / Transcript', ''];
    const KNOWN_ROLES = ['user', 'assistant', 'tool', 'system'];
    for (const role of KNOWN_ROLES) {
      const count = counts.get(role);
      if (count) lines.push(`  ${ROLE_LABELS[role]}：${count}`);
    }
    for (const [role, count] of counts) {
      if (KNOWN_ROLES.includes(role)) continue;
      lines.push(`  ${role}：${count}`);
    }
    lines.push(`  合计：${facts.messages.length}`, '', '导出完整对话：/export [format]');
    return { type: 'text', content: lines.join('\n') };
  },

  /** Skill inventory: name + description + where it came from. */
  skills: async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI?.skills : undefined;
    if (!api?.list) {
      return { type: 'error', message: '/skills: 技能接口不可用。' };
    }

    let result: { success: boolean; skills: unknown[]; error?: string };
    try {
      result = await api.list();
    } catch (error) {
      return {
        type: 'error',
        message: `/skills: 读取技能列表失败（${error instanceof Error ? error.message : String(error)}）`,
      };
    }
    if (!result.success) {
      return { type: 'error', message: `/skills: ${result.error ?? '读取技能列表失败。'}` };
    }

    const skills = (result.skills ?? []) as Array<{
      name?: string;
      description?: string;
      source?: string;
      sourceId?: string;
      category?: string;
      userInvocable?: boolean;
    }>;
    if (skills.length === 0) {
      return { type: 'text', content: ['可用技能 / Skills', '', '  未发现任何技能。'].join('\n') };
    }

    const lines = [`可用技能 / Skills（${skills.length}）`, ''];
    for (const skill of skills) {
      const source = SKILL_SOURCE_LABELS[skill.source ?? ''] ?? skill.source ?? '未知来源';
      const detail = skill.sourceId ? `${source}·${skill.sourceId}` : source;
      const desc = skill.description?.trim();
      const suffix = skill.userInvocable === false ? '（仅手动触发）' : '';
      lines.push(`  ${skill.name ?? '(未命名)'}${suffix}`);
      if (desc) lines.push(`    ${desc}`);
      lines.push(`    来源：${detail}`);
    }
    return { type: 'text', content: lines.join('\n') };
  },
};
