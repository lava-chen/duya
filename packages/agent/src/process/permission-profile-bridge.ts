/**
 * permission-profile-bridge.ts - DB profile 字符串 → agent internal mode 桥接
 *
 * 仅在 worker 端 chat:start 路径使用, 不在 agent 公共 API 暴露 full_access.
 * 关键: agent 的 permissionModeFromString 不识别 'full_access', 会 fallback 为 'default',
 *       因此本桥接必须先于 setPermissionMode 调用.
 */

export type AgentPermissionMode = 'default' | 'auto' | 'bypassPermissions';

export function isValidAgentMode(m: unknown): m is AgentPermissionMode {
  return m === 'default' || m === 'auto' || m === 'bypassPermissions';
}

export function profileToAgentMode(profile: string | null | undefined): AgentPermissionMode {
  if (profile === 'full_access') return 'bypassPermissions';
  if (profile === 'auto') return 'auto';
  return 'default';
}

export interface ChatStartPermissionInput {
  /** DB row 的 permission_profile 字段. 不可读时为 null. */
  rowProfile: string | null | undefined;
  /** 显式单次 override (trusted caller only). 类型: agent internal mode. */
  optionOverride: string | null | undefined;
  /** 旧字段. 故意读取只为记录 "被忽略" 日志, 不影响返回值. */
  deprecatedOption?: string | null | undefined;
}

export interface ChatStartPermissionResult {
  agentMode: AgentPermissionMode;
  fromRow: string | null;
  override: string | null;
  ignoredDeprecated: string | null;
}

/**
 * chat:start 路径纯函数, 决定最终 agent permission mode.
 *
 * 严格规则:
 *   - 默认: 来自 DB row 的 profile
 *   - 显式 override (类型合法): 覆盖 row
 *   - 显式 override (类型非法): 忽略, 走 row
 *   - 旧字段 options.permissionMode: **完全忽略**, 只在返回里记录以便日志
 *
 * 不抛错, 不读 DB. 调用方负责 try/catch 读取 row, 把 rowProfile 传进来.
 */
export function resolveChatStartAgentMode(input: ChatStartPermissionInput): ChatStartPermissionResult {
  const fromRow = input.rowProfile ?? null;
  let agentMode = profileToAgentMode(fromRow);

  let override: string | null = null;
  if (input.optionOverride && isValidAgentMode(input.optionOverride)) {
    agentMode = input.optionOverride;
    override = input.optionOverride;
  }

  const ignoredDeprecated = input.deprecatedOption ? String(input.deprecatedOption) : null;

  return { agentMode, fromRow, override, ignoredDeprecated };
}
