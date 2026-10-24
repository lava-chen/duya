/**
 * @duya/command-catalog
 *
 * The ONE place a slash command is defined: name, aliases, descriptions,
 * argument shape, and which surfaces expose it. The Desktop composer and the
 * CLI TUI both render their `/` popup and their `/help` from this list, so the
 * two can no longer quietly disagree about what exists.
 *
 * ## What lives here and what does not
 *
 * HERE: metadata and availability. THERE: behavior.
 *
 * Each surface keeps its own handlers, because they genuinely differ — the
 * Desktop acts on a renderer-side `CommandAppBridge`, the CLI acts over the
 * Host HTTP API. codex makes the same split (`slash_command.rs` holds the
 * definition and its `description()`; `slash_dispatch.rs` holds the behavior).
 * Trying to share an executor across a process boundary would couple two
 * very different transports for no benefit.
 *
 * ## The three rules this file exists to enforce
 *
 * 1. **Lookup is exact and unfiltered; only the popup filters.**
 *    `findSpec('/model')` resolves whether or not the current surface lists
 *    the command. A command hidden from a popup is still reachable by typing
 *    it — that is the difference between "not advertised" and "not
 *    implemented", and conflating them is how commands become dead letters.
 *
 * 2. **Availability is data, not a caller's judgement.**
 *    `surfaces`, `requiresSession` and `availableWhileBusy` are properties of
 *    the command. The popup asks the catalog what to show; it does not carry
 *    its own list. A surface that cannot run a command says so — it never
 *    drops the command silently and never lets it run and fail.
 *
 * 3. **Order is presentation order.**
 *    The array order below IS the order the popup renders — most-used first,
 *    matching codex's `// DO NOT ALPHA-SORT!` note on its enum.
 *
 * Adding a command means adding one entry here and one handler on the surface
 * that owns it. If a command exists in the catalog but neither surface can run
 * it, that is a bug in the surface, not a reason to delete the definition.
 */

/** A front end that can host a slash-command menu. */
export type CommandSurface = 'desktop' | 'cli';

/** Shared UI language preference used by the Desktop and terminal surfaces. */
export type CommandLocale = 'en' | 'zh';

/** Grouping for menus and `/help`. Shared so both surfaces section alike. */
export type CommandCategory = 'session' | 'config' | 'info' | 'tools' | 'exit';

/**
 * What a surface knows about itself when it renders a command list.
 *
 * The catalog is pure data, so availability is expressed as a question about
 * these facts rather than as a closure the catalog cannot serialize. A surface
 * fills in what it knows and asks the catalog what to show.
 *
 * This mirrors minimax-code's `TuiCommandContext`, which carries the same
 * facts (`hasSession` / `hasLiveRun` / `managedTokenPresent` / …) and lets
 * each command decide for itself with a `visibleWhen` predicate.
 */
export interface CommandContext {
  /** There is a session to act on. */
  readonly hasSession: boolean;
  /** A turn is currently streaming. */
  readonly busy: boolean;
}

export interface CommandSpec {
  /** Canonical name, no leading slash. */
  readonly name: string;
  /** Alternative spellings that resolve to the same command. */
  readonly aliases?: readonly string[];
  /** Short English menu title ("New session"). Required for desktop menus. */
  readonly label?: string;
  /** Short Chinese menu title ("新建会话"). Required for desktop menus. */
  readonly labelZh?: string;
  /** English description — the fallbacks for every locale. */
  readonly description: string;
  /** Chinese description used when the surface renders zh-CN. */
  readonly descriptionZh?: string;
  /** Argument placeholder for help and completion: "<title>", "[ask|auto]". */
  readonly argsHint?: string;
  /** Finite argument choices, for completion and validation. */
  readonly subcommands?: readonly string[];
  readonly category: CommandCategory;
  /** Surfaces that advertise this command. Lookup ignores this — see rule 1. */
  readonly surfaces: readonly CommandSurface[];
  /**
   * Also served by the Desktop's platform adapters. Gateway is not a front
   * end — it renders no menu — so this is a flag rather than a `surfaces`
   * entry, and it is independent of which front ends show the command.
   */
  readonly gateway?: boolean;
  /**
   * May this run while a turn is streaming? Model switches and interrupts are
   * safe; anything that mutates the conversation is not.
   */
  readonly availableWhileBusy?: boolean;
  /** Does the command accept free text after the name (`/rename <title>`)? */
  readonly supportsInlineArgs?: boolean;
  /**
   * Needs a live turn/session, so it is meaningless in an empty context.
   * Used by surfaces that hide commands until there is something to act on.
   */
  readonly requiresSession?: boolean;
  /**
   * Why this command cannot run right now, in the surface's own words.
   *
   * A command that is unavailable is still RESOLVABLE (rule 1), so the user
   * can always type it. This string is what they are told when they do —
   * without it the command either vanishes from the menu (the user concludes
   * it does not exist) or runs and fails (the user concludes it is broken).
   *
   * minimax-code does the same thing with `unavailableReason`; the catalog
   * stores the text so both surfaces explain themselves identically.
   */
  readonly unavailableReason?: string;
}

/**
 * Ordered: this array order is the popup order. Most-used first.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  // ── session ───────────────────────────────────────────────────────────
  {
    name: 'new',
    label: 'New session',
    labelZh: '新建会话',
    // `reset` was already accepted by the Desktop composer before the catalog
    // existed; writing it down here keeps the shared definition from narrowing
    // what either surface resolves.
    aliases: ['reset'],
    description: 'Start a new session',
    descriptionZh: '开始一个新会话',
    category: 'session',
    surfaces: ['desktop', 'cli'],
    gateway: true,
  },
  {
    name: 'resume',
    label: 'Resume session',
    labelZh: '恢复会话',
    aliases: ['sessions'],
    description: 'Search and resume a previous session',
    descriptionZh: '搜索并切换到之前的会话',
    argsHint: '[query]',
    category: 'session',
    surfaces: ['desktop', 'cli'],
  },
  {
    name: 'fork',
    label: 'Fork session',
    labelZh: '分叉会话',
    description: 'Fork this session into a new one',
    descriptionZh: '把当前会话分叉成新会话',
    argsHint: '[messageId]',
    category: 'session',
    surfaces: ['cli'],
  },
  {
    name: 'rename',
    label: 'Rename session',
    labelZh: '重命名会话',
    aliases: ['title'],
    description: 'Rename the current session',
    descriptionZh: '重命名当前会话',
    argsHint: '[title]',
    category: 'session',
    surfaces: ['desktop', 'cli'],
    supportsInlineArgs: true,
    requiresSession: true,
  },
  {
    name: 'archive',
    label: 'Archive session',
    labelZh: '归档会话',
    description: 'Archive the current session',
    descriptionZh: '归档当前会话',
    category: 'session',
    surfaces: ['cli'],
  },
  {
    name: 'delete',
    label: 'Delete session',
    labelZh: '删除会话',
    description: 'Permanently delete the current session',
    descriptionZh: '永久删除当前会话',
    category: 'session',
    surfaces: ['cli'],
  },
  {
    name: 'clear',
    label: 'Clear conversation',
    labelZh: '清空对话',
    description: 'Clear the conversation',
    descriptionZh: '清空当前会话的所有消息',
    category: 'session',
    surfaces: ['desktop', 'cli'],
  },
  {
    name: 'compact',
    label: 'Compact context',
    labelZh: '压缩上下文',
    description: 'Compress conversation context to save tokens',
    descriptionZh: '压缩对话上下文以节省 token',
    category: 'session',
    // The CLI reaches the same worker-side compaction through a Host HTTP exit.
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
  },
  {
    name: 'export',
    label: 'Export conversation',
    labelZh: '导出对话',
    description: 'Export the conversation to markdown/json',
    descriptionZh: '将会话导出为 markdown/json',
    argsHint: '[format|directory]',
    category: 'session',
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
    // Reading the transcript mid-turn is safe: it does not touch the run.
    availableWhileBusy: true,
  },
  {
    // Plan 610 T15. The handshake answer is otherwise invisible: a refusal was
    // correct and the person at the keyboard had no way to see why. `cli` only
    // — the Desktop renders capabilities in its own settings surface, and
    // advertising it here without a Desktop executor is exactly the
    // advertised-but-unrunnable state the catalog's integrity tests forbid.
    name: 'capabilities',
    label: 'Show host capabilities',
    labelZh: '显示 Host 能力',
    description: 'Show what this Host serves and what this CLI may rely on',
    descriptionZh: '显示该 Host 提供的能力，以及本 CLI 可以依赖的能力',
    category: 'session',
    surfaces: ['cli'],
    requiresSession: false,
    // A capability handshake is a read; it does not touch the run.
    availableWhileBusy: true,
  },
  {
    // Plan 610 T15. The first command that actually CONSUMES a Host capability:
    // `/capabilities` prints the negotiation, this one asks for a file, so the
    // advertised name is proved rather than assumed. `cli` only — there is no
    // Desktop executor, and advertising it there is the advertised-but-
    // unrunnable state the catalog's integrity tests forbid.
    name: 'read-file',
    label: 'Read workspace file',
    labelZh: '读取工作区文件',
    description: 'Read a file from this session\'s workspace through the Host',
    descriptionZh: '通过 Host 读取当前会话工作区中的文件',
    category: 'session',
    surfaces: ['cli'],
    requiresSession: true,
    // A file read does not touch the run.
    availableWhileBusy: true,
  },
  {
    // `copy` has a Desktop executor (executors/session.ts) that no popover entry
    // ever reached, so the handler was unreachable from the composer. Listed
    // here because the capability is real; the metadata simply had to be
    // written down.
    name: 'copy',
    label: 'Copy last reply',
    labelZh: '复制最后一条回复',
    description: 'Copy the last reply to the clipboard',
    descriptionZh: '复制最后一条回复',
    category: 'session',
    surfaces: ['desktop', 'cli'],
    // Copying the last reply is a read; it does not touch the run.
    availableWhileBusy: true,
  },
  {
    name: 'stop',
    label: 'Stop turn',
    labelZh: '停止当前回合',
    aliases: ['interrupt'],
    description: 'Interrupt the running turn',
    descriptionZh: '中断当前正在进行的回答',
    category: 'session',
    surfaces: ['desktop', 'cli'],
    availableWhileBusy: true,
  },
  {
    name: 'queue',
    label: 'Queued messages',
    labelZh: '队列消息',
    description: 'Manage queued follow-up messages',
    descriptionZh: '管理排队的后续消息',
    argsHint: '[clear|resume]',
    subcommands: ['clear', 'resume'],
    category: 'session',
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
  },
  {
    name: 'exit',
    label: 'Leave the chat',
    labelZh: '退出当前聊天',
    aliases: ['quit', 'q'],
    description: 'Leave the chat',
    descriptionZh: '退出当前聊天',
    category: 'exit',
    surfaces: ['cli'],
  },

  // ── config ────────────────────────────────────────────────────────────
  {
    name: 'model',
    label: 'Switch model',
    labelZh: '切换模型',
    description: 'Switch the model for this session',
    descriptionZh: '为当前会话切换模型',
    argsHint: '[model]',
    category: 'config',
    surfaces: ['desktop', 'cli'],
  },
  {
    // pi's name for the same ladder. duya calls it effort because that is what
    // the Desktop control and the wire field call it; this is the spelling a
    // pi user types without thinking about it.
    name: 'thinking',
    label: 'Thinking level',
    labelZh: '思考强度',
    description: 'Set the thinking level for the next turns',
    descriptionZh: '设置后续回合的思考强度',
    argsHint: '[level]',
    category: 'config',
    surfaces: ['cli'],
    // Effort applies to the NEXT turn; the running one is unaffected.
    availableWhileBusy: true,
  },
  {
    name: 'permission',
    label: 'Permission mode',
    labelZh: '权限模式',
    aliases: ['permissions'],
    description: 'Show or set the permission mode',
    descriptionZh: '查看或设置权限模式',
    argsHint: '[ask|auto|bypass]',
    subcommands: ['ask', 'auto', 'bypass'],
    category: 'config',
    surfaces: ['desktop', 'cli'],
    // The mode applies to the NEXT tool call; the running turn keeps the
    // profile it started with.
    availableWhileBusy: true,
  },
  {
    name: 'settings',
    label: 'TUI settings',
    labelZh: '终端设置',
    description: 'Configure the terminal: theme, display, effort, transcript',
    descriptionZh: '配置终端：主题、显示、推理强度、会话记录',
    category: 'config',
    surfaces: ['cli'],
    availableWhileBusy: true,
  },
  {
    name: 'hotkeys',
    label: 'Keyboard shortcuts',
    labelZh: '键盘快捷键',
    description: 'Show every keyboard shortcut',
    descriptionZh: '显示所有键盘快捷键',
    category: 'config',
    surfaces: ['cli'],
    // Safe mid-turn: it reads the binding table and paints a panel, touching
    // neither the transcript nor the run.
    availableWhileBusy: true,
  },
  {
    // One canonical `effort`, on both surfaces. It was briefly declared twice
    // (once per surface) and the catalog's unique-name gate said so — a name
    // that exists twice is a name that resolves differently depending on which
    // half of the list you happen to read. The Desktop shows these levels in
    // its composer control; the CLI validates against what the model declares.
    name: 'effort',
    label: 'Reasoning effort',
    labelZh: '推理强度',
    description: 'Set reasoning effort for the next turns',
    descriptionZh: '设置后续回合的推理强度',
    argsHint: '[level]',
    subcommands: ['none', 'minimal', 'low', 'medium', 'high'],
    category: 'config',
    surfaces: ['desktop', 'cli'],
    // Effort applies to the NEXT turn; the running one is unaffected.
    availableWhileBusy: true,
  },
  {
    name: 'login',
    label: 'Login',
    labelZh: '登录',
    description: 'Connect or manage a model provider',
    descriptionZh: '连接或管理模型提供商',
    argsHint: '[add|manage]',
    subcommands: ['add', 'manage'],
    category: 'config',
    surfaces: ['desktop'],
  },
  {
    name: 'logout',
    label: 'Logout',
    labelZh: '登出',
    description: 'Sign out of a model provider',
    descriptionZh: '退出模型提供商登录',
    category: 'config',
    surfaces: ['desktop'],
  },

  // ── info ──────────────────────────────────────────────────────────────
  {
    name: 'help',
    label: 'Help',
    labelZh: '查看帮助',
    aliases: ['?'],
    description: 'Show available commands',
    descriptionZh: '显示可用的命令列表',
    category: 'info',
    surfaces: ['desktop', 'cli'],
    gateway: true,
    // Listing the commands is the one thing a user is most likely to want
    // precisely while a turn is running — hiding it then is backwards.
    availableWhileBusy: true,
  },
  {
    name: 'status',
    label: 'Session status',
    labelZh: '会话状态',
    description: 'Show session info (model, provider, messages)',
    descriptionZh: '查看当前会话信息',
    category: 'info',
    surfaces: ['desktop', 'cli'],
    gateway: true,
    availableWhileBusy: true,
  },
  {
    name: 'cost',
    label: 'Token usage',
    labelZh: '用量统计',
    aliases: ['usage'],
    description: 'Show token usage and estimated cost',
    descriptionZh: '查看 token 用量与费用估算',
    category: 'info',
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
    availableWhileBusy: true,
  },
  {
    name: 'context',
    label: 'Context usage',
    labelZh: '上下文用量',
    description: 'Show context window usage',
    descriptionZh: '查看当前会话的上下文窗口用量',
    category: 'info',
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
    availableWhileBusy: true,
  },
  {
    // The one view whose whole purpose is to be opened WHILE a turn runs: a
    // promoted bash command or a subagent outlives the model's answer, and the
    // user needs to inspect it without waiting for the run to finish.
    name: 'tasks',
    label: 'Background tasks',
    labelZh: '后台任务',
    description: 'Show background bash tasks and subagents',
    descriptionZh: '查看后台 bash 任务与子代理',
    category: 'info',
    surfaces: ['cli'],
    requiresSession: true,
    availableWhileBusy: true,
  },
  {
    name: 'transcript',
    label: 'Transcript stats',
    labelZh: '转录统计',
    description: 'Show transcript statistics',
    descriptionZh: '查看会话消息统计',
    category: 'info',
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
    availableWhileBusy: true,
  },
  {
    // Plan 621 slice F. The checkout this session sits in, as the Host
    // observes it. `cli` only — the Desktop renders it in the shared
    // workspace-lifecycle panel, not as a composer command, so advertising
    // it there without a Desktop executor would be the advertised-but-
    // unrunnable state the catalog's integrity tests forbid.
    name: 'checkout',
    label: 'Checkout status',
    labelZh: '工作副本状态',
    description: 'Show the checkout this session sits in',
    descriptionZh: '查看当前会话所在的工作副本',
    category: 'info',
    surfaces: ['cli'],
    requiresSession: true,
    availableWhileBusy: true,
  },
  {
    // Plan 621 slice F. The pull requests this session is associated with.
    // `refresh` is the only network-touching form: the plain read is a
    // projection read that never leaves the machine.
    name: 'pr',
    label: 'Pull requests',
    labelZh: 'Pull Request',
    description: 'Show the pull requests associated with this session',
    descriptionZh: '查看与当前会话关联的 Pull Request',
    argsHint: '[refresh]',
    subcommands: ['refresh'],
    category: 'info',
    surfaces: ['cli'],
    requiresSession: true,
    availableWhileBusy: true,
  },
  {
    name: 'recap',
    label: 'Recap conversation',
    labelZh: '回顾对话',
    aliases: ['summary', 'catchup'],
    description: 'Summarize the current conversation',
    descriptionZh: '生成当前对话的回顾摘要',
    category: 'info',
    surfaces: ['desktop'],
    requiresSession: true,
  },
  {
    name: 'skills',
    label: 'Skills',
    labelZh: '技能列表',
    description: 'List available skills',
    descriptionZh: '列出可用的技能',
    category: 'info',
    surfaces: ['desktop'],
    // Listing skills is a read.
    availableWhileBusy: true,
  },

  // ── tools ─────────────────────────────────────────────────────────────
  {
    name: 'plan',
    label: 'Enter plan mode',
    labelZh: '进入规划模式',
    description: 'Enter planning mode for complex tasks',
    descriptionZh: '为复杂任务进入规划模式',
    category: 'tools',
    surfaces: ['desktop'],
    requiresSession: true,
  },
  {
    name: 'goal',
    label: 'Goal mode',
    labelZh: '目标模式',
    description: 'Track a long-running goal across rounds',
    descriptionZh: '多轮自主目标追踪',
    argsHint: '<objective|status|pause|resume|clear>',
    subcommands: ['status', 'pause', 'resume', 'clear'],
    category: 'tools',
    surfaces: ['desktop'],
    requiresSession: true,
    supportsInlineArgs: true,
  },
  {
    name: 'deep-research',
    label: 'Deep research',
    labelZh: '深度研究',
    aliases: ['research'],
    description: 'Enter deep research mode',
    descriptionZh: '进入深度研究模式',
    argsHint: '[query]',
    category: 'tools',
    surfaces: ['desktop'],
    requiresSession: true,
    supportsInlineArgs: true,
  },
  {
    name: 'diff',
    label: 'Code review',
    labelZh: '代码审查',
    // Desktop opens the code-review panel; the CLI prints the same working
    // tree diff as text. One description, two surfaces — the wording stays
    // true for both.
    description: 'Show the code changes in the working tree (git diff)',
    descriptionZh: '查看工作区的代码改动（git diff）',
    category: 'tools',
    surfaces: ['desktop', 'cli'],
    // The panel reads git state; it does not touch the run.
    availableWhileBusy: true,
  },
  {
    name: 'loop',
    label: 'Recurring task',
    labelZh: '定时循环',
    description: 'Create a recurring automation',
    descriptionZh: '创建定时自动化',
    argsHint: '[interval] [prompt]',
    category: 'tools',
    surfaces: ['desktop'],
    requiresSession: true,
    supportsInlineArgs: true,
  },
  {
    name: 'memory',
    label: 'Memory',
    labelZh: '记忆',
    description: 'Open the memory panel',
    descriptionZh: '打开记忆面板',
    category: 'tools',
    surfaces: ['desktop'],
    // Opening a panel does not touch the run.
    availableWhileBusy: true,
  },
  {
    name: 'mcp',
    label: 'MCP connections',
    labelZh: 'MCP 连接',
    description: 'Open MCP connection settings',
    descriptionZh: '打开 MCP 连接设置',
    category: 'tools',
    surfaces: ['desktop'],
    // Opening a panel does not touch the run.
    availableWhileBusy: true,
  },
  {
    name: 'add-dir',
    label: 'Add directory',
    labelZh: '添加目录',
    description: 'Add a workspace directory',
    descriptionZh: '添加一个工作区目录',
    argsHint: '[path]',
    category: 'tools',
    surfaces: ['desktop'],
  },
  {
    name: 'image',
    label: 'Generate image',
    labelZh: '生成图片',
    description: 'Generate an image from a prompt',
    descriptionZh: '根据提示词生成图片',
    argsHint: '<prompt>',
    category: 'tools',
    surfaces: ['desktop'],
    requiresSession: true,
    supportsInlineArgs: true,
  },
  {
    name: 'btw',
    label: 'Side question',
    labelZh: '旁问',
    description: 'Ask a side question without interrupting',
    descriptionZh: '不打断当前对话的旁侧问答',
    argsHint: '[question]',
    category: 'tools',
    surfaces: ['desktop', 'cli'],
    requiresSession: true,
    // A side question is asked PRECISELY while a turn runs — that is the
    // whole point of the command, so it must not be gated on an idle turn.
    availableWhileBusy: true,
    supportsInlineArgs: true,
  },
];

const BY_TOKEN = new Map<string, CommandSpec>();
for (const spec of COMMAND_SPECS) {
  BY_TOKEN.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) BY_TOKEN.set(alias, spec);
}

/**
 * Exact lookup by token (no leading slash). Deliberately IGNORES `surfaces`
 * and `requiresSession`: a command that a surface does not advertise is still
 * resolvable there, so typing it produces the command's own behaviour (or its
 * own "not available" message) instead of "unknown command".
 */
export function findSpec(token: string): CommandSpec | undefined {
  return BY_TOKEN.get(token.trim().toLowerCase());
}

/** Canonical name for a token that may be an alias. */
export function canonicalName(token: string): string | undefined {
  return findSpec(token)?.name;
}

/**
 * What a surface should ADVERTISE — the popup list and `/help`. This is the
 * filtered view; `findSpec` is the unfiltered one.
 */
export function specsForSurface(
  surface: CommandSurface,
  options: { readonly hasSession?: boolean; readonly busy?: boolean } = {},
): readonly CommandSpec[] {
  return COMMAND_SPECS.filter((spec) => {
    if (!spec.surfaces.includes(surface)) return false;
    if (options.hasSession === false && spec.requiresSession === true) return false;
    if (options.busy === true && spec.availableWhileBusy !== true) return false;
    return true;
  });
}

/**
 * Whether a command can run right now, and why not when it cannot.
 *
 * This is the answer to "the user typed a command that exists but cannot
 * work here". The command stays resolvable (rule 1) so the surface can tell
 * the user WHY instead of forwarding the token to the model as prose.
 *
 * The reason text comes from the spec, so the Desktop and the CLI explain
 * themselves the same way. `availableWhileBusy` and `requiresSession` are the
 * two facts a spec can declare; a spec that declares neither is always
 * available.
 */
export function commandAvailability(
  spec: CommandSpec,
  context: CommandContext,
): { readonly available: true } | { readonly available: false; readonly reason: string } {
  if (spec.requiresSession === true && !context.hasSession) {
    return {
      available: false,
      reason: spec.unavailableReason ?? `Start a session before using /${spec.name}.`,
    };
  }
  if (spec.availableWhileBusy !== true && context.busy) {
    return {
      available: false,
      reason: spec.unavailableReason ?? `Stop the running turn before using /${spec.name}.`,
    };
  }
  return { available: true };
}

/**
 * The commands a surface should show, given what it knows about itself.
 *
 * Same list as `specsForSurface`, but the caller supplies a `CommandContext`
 * instead of loose booleans, so a surface cannot half-fill the facts and get
 * a menu that disagrees with what it can actually run.
 */
export function availableSpecsFor(
  surface: CommandSurface,
  context: CommandContext,
): readonly CommandSpec[] {
  return COMMAND_SPECS.filter(
    (spec) =>
      spec.surfaces.includes(surface) &&
      commandAvailability(spec, context).available,
  );
}

/** Chinese description when present, else the English one. */
export function describeSpec(spec: CommandSpec, locale: CommandLocale = 'zh'): string {
  return locale === 'zh' ? (spec.descriptionZh ?? spec.description) : spec.description;
}

/** `/name [hint]` plus any aliases, as a single display string. */
export function formatSpecLabel(spec: CommandSpec): string {
  const args = spec.argsHint === undefined ? '' : ` ${spec.argsHint}`;
  const aliases = spec.aliases === undefined || spec.aliases.length === 0
    ? ''
    : `, /${spec.aliases.join(', /')}`;
  return `/${spec.name}${args}${aliases}`;
}
