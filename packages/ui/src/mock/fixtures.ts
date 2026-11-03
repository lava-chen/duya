/**
 * The mock's canned world.
 *
 * ## What this is
 *
 * The UI mock renders the REAL components, so what it needs is the DATA the
 * real app would have read from the Host: sessions, transcripts and run
 * events. This file is that data — hand-written, small, and shaped exactly
 * like the protocol's own shapes so the mock exercises the real projection
 * code instead of a simplified copy of it.
 *
 * ## Why the shapes are copied from the protocol and not invented
 *
 * The run script below is a list of `RunEventEnvelope`s: the same envelopes
 * the Host's ledger serves. The shared renderer reduces them through
 * `SurfaceModel`, so a mock that emitted something else would be testing the
 * mock rather than the product. Everything here is therefore a legal event
 * sequence, not a sketch of one.
 *
 * ## What is deliberately NOT here
 *
 * No worker, no model, no filesystem, no clock. Every timestamp is a constant
 * so a screenshot taken twice looks the same.
 */

import type {
  HostPermissionRequest,
  HostProviderCatalog,
  RunEventEnvelope,
  RunManifest,
} from '@duya/agent-protocol';
import type { Message } from '@/types/message';
import type { ProjectGroup, Thread } from '@/stores/conversation-store';

/** A fixed instant so every mock render is byte-for-byte repeatable. */
export const MOCK_EPOCH = 1_760_000_000_000;

export const MOCK_SESSION_IDS = {
  sidebar: 'mock-session-sidebar',
  panels: 'mock-session-panels',
  approval: 'mock-session-approval',
  tools: 'mock-session-tools',
  empty: 'mock-session-empty',
} as const;

/** A short, real-feeling answer. The mock is about structure, not prose. */
const REPLY_SIDEBAR = [
  '先把问题拆成两块：**信息架构**和**操作密度**。',
  '',
  '- 当前侧栏按项目分组，项目一多就找不到会话；',
  '- 按时间分组更接近"我刚才在干什么"的直觉。',
  '',
  '改动只涉及分组维度，不动会话行的结构。',
].join('\n');

const REPLY_PANELS = [
  '右侧面板现在是 **Code Review / Terminal / Preview** 并列。',
  '',
  '要合并的话，关键是让"当前面板"有一个统一入口，而不是三个平级 tab。',
].join('\n');

const REPLY_TOOLS = [
  '工具卡片目前和正文平级，视觉噪音大。',
  '',
  '建议默认折叠成一行摘要，展开才看输入输出。',
].join('\n');

/** Split a paragraph into deltas so the mock streams like a real turn. */
function chunk(text: string, size = 18): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

interface ScriptOptions {
  readonly runId: string;
  readonly sessionId: string;
  readonly reply: string;
  /** A tool call rendered between the reply and the closing line. */
  readonly tool?: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly result: string;
  };
  /** A permission request that is never answered: the card stays open. */
  readonly pendingPermission?: {
    readonly requestId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly toolInput: Record<string, unknown>;
    readonly reason: string;
  };
}

/**
 * Build one run's event script.
 *
 * The sequence is the protocol's own: the run opens, the turn opens, the
 * agent works, the assistant closes, the turn and the run settle. A pending
 * permission stops the script before the turn closes — that is what makes the
 * approval card render.
 *
 * ## The ORDER of the reply is load-bearing
 *
 * The renderer treats text BEFORE the last tool/thinking action as the
 * agent's intermediate narration (it stays folded inside the collapsed tool
 * group) and text AFTER it as the final reply (it renders below the group).
 * So the tool has to come FIRST and the reply LAST — which is also the order
 * a real Host produces: the agent calls a tool, reads the result, and only
 * then writes its answer. A script that replies before it works renders as
 * an empty round.
 */
export function buildRunScript(options: ScriptOptions): RunEventEnvelope[] {
  const { runId, sessionId, reply, tool, pendingPermission } = options;
  const events: RunEventEnvelope[] = [];
  let seq = 0;

  const push = (payload: Record<string, unknown>): void => {
    seq += 1;
    events.push({
      runId,
      sessionId,
      seq,
      timestamp: MOCK_EPOCH + seq * 1000,
      traceId: `trace-${runId}`,
      payload: { type: 'unknown', ...payload },
    } as unknown as RunEventEnvelope);
  };

  push({
    type: 'run.started',
    manifestHash: 'a'.repeat(64),
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'duya-mock', version: '0.0.0-mock' },
  });

  push({
    type: 'turn.started',
    turnId: `${runId}-turn-1`,
    index: 0,
    model: 'mock-model',
    providerId: 'mock-provider',
    apiFormat: 'anthropic',
  });

  // The work happens BEFORE the reply — see the note above.
  if (tool !== undefined) {
    push({
      type: 'tool.call_started',
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      arguments: tool.arguments,
      attempt: 1,
    });
    push({
      type: 'tool.call_completed',
      toolCallId: tool.toolCallId,
      content: tool.result,
      outcome: { outcome: 'success' },
      durationMs: 42,
    });
  }

  const messageId = `${runId}-msg-1`;
  for (const delta of chunk(reply)) {
    push({ type: 'assistant.text_delta', messageId, index: 0, delta });
  }
  push({
    type: 'assistant.message_finalized',
    messageId,
    content: [{ type: 'text', text: reply }],
    stopReason: 'end_turn',
  });

  if (pendingPermission !== undefined) {
    push({
      type: 'permission.requested',
      requestId: pendingPermission.requestId,
      kind: 'tool_use',
      toolCallId: pendingPermission.toolCallId,
      toolName: pendingPermission.toolName,
      toolInput: pendingPermission.toolInput,
      mode: 'generic',
      startedAt: MOCK_EPOCH,
      expiresAt: MOCK_EPOCH + 300_000,
      reason: pendingPermission.reason,
    });
    return events;
  }

  push({
    type: 'turn.completed',
    turnId: `${runId}-turn-1`,
    index: 0,
    stopReason: 'end_turn',
    usage: { inputTokens: 1024, outputTokens: 256, totalTokens: 1280 },
    durationMs: 1800,
  });
  push({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
  return events;
}

export interface MockRunFixture {
  readonly runId: string;
  readonly sessionId: string;
  readonly events: readonly RunEventEnvelope[];
  /** A run that never settles: the mock keeps it open until the run drains. */
  readonly open: boolean;
}

export const MOCK_RUNS: readonly MockRunFixture[] = [
  {
    runId: 'mock-run-sidebar',
    sessionId: MOCK_SESSION_IDS.sidebar,
    open: false,
    events: buildRunScript({
      runId: 'mock-run-sidebar',
      sessionId: MOCK_SESSION_IDS.sidebar,
      reply: REPLY_SIDEBAR,
      tool: {
        toolCallId: 'mock-tool-read-1',
        toolName: 'Read',
        arguments: { file_path: 'packages/ui/src/components/layout/app-sidebar.tsx' },
        result: 'Read 2225 lines from app-sidebar.tsx',
      },
    }),
  },
  {
    runId: 'mock-run-panels',
    sessionId: MOCK_SESSION_IDS.panels,
    open: false,
    events: buildRunScript({
      runId: 'mock-run-panels',
      sessionId: MOCK_SESSION_IDS.panels,
      reply: REPLY_PANELS,
    }),
  },
  {
    runId: 'mock-run-approval',
    sessionId: MOCK_SESSION_IDS.approval,
    open: true,
    events: buildRunScript({
      runId: 'mock-run-approval',
      sessionId: MOCK_SESSION_IDS.approval,
      reply: '这条命令要写到项目外，我先确认一下。',
      pendingPermission: {
        requestId: 'mock-permission-1',
        toolCallId: 'mock-tool-bash-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf ./build-cache' },
        reason: '命令的目标在工作区之外，需要确认。',
      },
    }),
  },
  {
    runId: 'mock-run-tools',
    sessionId: MOCK_SESSION_IDS.tools,
    open: false,
    events: buildRunScript({
      runId: 'mock-run-tools',
      sessionId: MOCK_SESSION_IDS.tools,
      reply: REPLY_TOOLS,
      tool: {
        toolCallId: 'mock-tool-grep-1',
        toolName: 'Grep',
        arguments: { pattern: 'msgType: .tool_use.', path: 'packages/ui/src' },
        result: 'packages/ui/src/components/chat/tools/rows/FileEditToolRow.tsx:44',
      },
    }),
  },
  {
    runId: 'mock-run-empty',
    sessionId: MOCK_SESSION_IDS.empty,
    open: false,
    events: buildRunScript({
      runId: 'mock-run-empty',
      sessionId: MOCK_SESSION_IDS.empty,
      reply: '这一轮只是占位，用来演示空会话的样子。',
    }),
  },
];

/** The sidebar's session list. */
export const MOCK_THREADS: readonly Thread[] = [
  {
    id: MOCK_SESSION_IDS.sidebar,
    title: '侧栏分组重构',
    workingDirectory: 'E:\\Projects\\duya',
    projectName: 'duya',
    createdAt: MOCK_EPOCH - 86_400_000,
    updatedAt: MOCK_EPOCH - 600_000,
    providerId: 'mock-provider',
    model: 'mock-model',
    agentType: 'main',
    agentName: '独雅',
    recencyAt: MOCK_EPOCH - 600_000,
  },
  {
    id: MOCK_SESSION_IDS.panels,
    title: '右侧面板合并的取舍',
    workingDirectory: 'E:\\Projects\\duya',
    projectName: 'duya',
    createdAt: MOCK_EPOCH - 172_800_000,
    updatedAt: MOCK_EPOCH - 7_200_000,
    providerId: 'mock-provider',
    model: 'mock-model',
    agentType: 'main',
    agentName: '独雅',
    recencyAt: MOCK_EPOCH - 7_200_000,
  },
  {
    id: MOCK_SESSION_IDS.approval,
    title: '审批弹窗放在哪一层',
    workingDirectory: 'E:\\Projects\\duya-web',
    projectName: 'duya-web',
    createdAt: MOCK_EPOCH - 259_200_000,
    updatedAt: MOCK_EPOCH - 86_400_000,
    providerId: 'mock-provider',
    model: 'mock-model',
    agentType: 'main',
    agentName: '独雅',
    recencyAt: MOCK_EPOCH - 86_400_000,
  },
  {
    id: MOCK_SESSION_IDS.tools,
    title: '工具卡片的层级',
    workingDirectory: 'E:\\Projects\\atlas-ink',
    projectName: 'atlas-ink',
    createdAt: MOCK_EPOCH - 345_600_000,
    updatedAt: MOCK_EPOCH - 172_800_000,
    providerId: 'mock-provider',
    model: 'mock-model',
    agentType: 'main',
    agentName: '独雅',
    recencyAt: MOCK_EPOCH - 172_800_000,
  },
  {
    id: MOCK_SESSION_IDS.empty,
    title: '新对话',
    workingDirectory: null,
    projectName: null,
    createdAt: MOCK_EPOCH - 432_000_000,
    updatedAt: MOCK_EPOCH - 432_000_000,
    providerId: 'mock-provider',
    model: 'mock-model',
    agentType: 'main',
    agentName: '独雅',
    recencyAt: MOCK_EPOCH - 432_000_000,
  },
];

/** The sidebar's project groups. */
export const MOCK_PROJECT_GROUPS: readonly ProjectGroup[] = [
  {
    workingDirectory: 'E:\\Projects\\duya',
    projectName: 'duya',
    threadCount: 2,
    lastActivity: MOCK_EPOCH - 600_000,
    createdAt: MOCK_EPOCH - 86_400_000,
    isExpanded: true,
  },
  {
    workingDirectory: 'E:\\Projects\\duya-web',
    projectName: 'duya-web',
    threadCount: 1,
    lastActivity: MOCK_EPOCH - 86_400_000,
    createdAt: MOCK_EPOCH - 259_200_000,
    isExpanded: true,
  },
  {
    workingDirectory: 'E:\\Projects\\atlas-ink',
    projectName: 'atlas-ink',
    threadCount: 1,
    lastActivity: MOCK_EPOCH - 172_800_000,
    createdAt: MOCK_EPOCH - 345_600_000,
    isExpanded: true,
  },
];

/**
 * The USER side of each transcript.
 *
 * The assistant's side comes from the run projection (the same path the
 * product uses), so only the user's turn is seeded here.
 */
export const MOCK_USER_MESSAGES: Readonly<Record<string, Message[]>> = {
  [MOCK_SESSION_IDS.sidebar]: [
    {
      id: 'mock-msg-sidebar-user',
      role: 'user',
      content: '侧栏现在按项目分组，项目一多就很难找到刚才那个会话。要不要改成按时间分组？',
      timestamp: MOCK_EPOCH - 700_000,
      source: 'user',
    },
  ],
  [MOCK_SESSION_IDS.panels]: [
    {
      id: 'mock-msg-panels-user',
      role: 'user',
      content: '右侧那三个面板能不能合成一个入口？现在切来切去很跳。',
      timestamp: MOCK_EPOCH - 7_300_000,
      source: 'user',
    },
  ],
  [MOCK_SESSION_IDS.approval]: [
    {
      id: 'mock-msg-approval-user',
      role: 'user',
      content: '跑一下清理命令。',
      timestamp: MOCK_EPOCH - 86_500_000,
      source: 'user',
    },
  ],
  [MOCK_SESSION_IDS.tools]: [
    {
      id: 'mock-msg-tools-user',
      role: 'user',
      content: '工具卡片现在跟正文一样重，看久了很吵。',
      timestamp: MOCK_EPOCH - 172_900_000,
      source: 'user',
    },
  ],
  [MOCK_SESSION_IDS.empty]: [],
};

/** The approval the mock leaves open, so the permission card renders. */
export const MOCK_PENDING_APPROVAL: HostPermissionRequest = {
  id: 'mock-permission-1',
  sessionId: MOCK_SESSION_IDS.approval,
  toolName: 'Bash',
  toolInput: { command: 'rm -rf ./build-cache' },
  mode: 'generic',
  expiresAt: MOCK_EPOCH + 300_000,
  reason: '命令的目标在工作区之外，需要确认。',
  status: 'pending',
  decision: null,
  message: null,
  updatedPermissions: null,
  updatedInput: null,
  createdAt: MOCK_EPOCH,
  resolvedAt: null,
};

/** A small roster so the model picker is not empty. */
export const MOCK_PROVIDER_CATALOG: HostProviderCatalog = {
  providers: [
    {
      providerId: 'mock-provider',
      name: 'Mock Provider',
      providerType: 'anthropic',
      hasApiKey: true,
      defaultModel: 'mock-model',
      models: [
        {
          modelId: 'mock-model',
          displayName: 'Mock Model',
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
          supportsReasoning: true,
          supportsVision: false,
          reasoningEffortOptions: ['low', 'medium', 'high'],
          isProviderDefault: true,
        },
      ],
    },
  ],
  activeProviderId: 'mock-provider',
  activeModel: 'mock-model',
  configRoot: 'C:\\mock',
};

/**
 * A minimal but complete `RunManifest`.
 *
 * The run ledger row carries a manifest, and the manifest is a big record.
 * The mock states plainly that every value in it was synthesised, because a
 * fabricated manifest that claimed provenance would be a lie the mock should
 * not tell.
 */
export function buildMockManifest(runId: string, sessionId: string): RunManifest {
  const synthesised = { source: 'unsupported', synthesised: true } as const;
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: sessionId,
    roots: ['E:\\Projects\\duya'],
    cwd: 'E:\\Projects\\duya',
    permissionPolicy: {
      mode: 'default',
      hostSwitch: 'ask',
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:mock', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'mock-model', providerId: 'mock-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: synthesised,
      cwd: synthesised,
      permissionPolicy: synthesised,
      capabilities: synthesised,
      connectorBindings: synthesised,
      env: synthesised,
      agent: synthesised,
      budget: synthesised,
      workspaceId: synthesised,
      projectId: synthesised,
      deterministic: synthesised,
    },
  } as unknown as RunManifest;
}
