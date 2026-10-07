/**
 * permission-profile-bridge.ts - DB profile 字符串 → agent internal mode 桥接
 *
 * 仅在 worker 端 chat:start 路径使用, 不在 agent 公共 API 暴露 full_access.
 * 关键: agent 的 permissionModeFromString 不识别 'full_access', 会 fallback 为 'default',
 *       因此本桥接必须先于 setPermissionMode 调用.
 */

import { toExternalPermissionMode } from '../permissions/policy.js';
import type { ExternalPermissionMode } from '../permissions/types.js';

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
}

export interface ChatStartPermissionResult {
  agentMode: AgentPermissionMode;
  fromRow: string | null;
  override: string | null;
}

/**
 * chat:start 路径纯函数, 决定最终 agent permission mode.
 *
 * 严格规则:
 *   - 默认: 来自 DB row 的 profile
 *   - 显式 override (类型合法): 覆盖 row
 *   - 显式 override (类型非法): 忽略, 走 row
 *
 * Plan 583 / ISS-09: 旧的 `options.permissionMode` 字段已从 wire 协议删除,
 * 不再读取也不再记录 —— 旧 sender 携带该字段时它只是普通多余属性, 结构性
 * 无法被采信, 不需要"读了再忽略"的防御分支.
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

  return { agentMode, fromRow, override };
}

/**
 * Plan 610 P8: the PROTOCOL mode the run manifest records for a resolved agent
 * mode.
 *
 * ## Why this is a function and not an inline ternary at the call site
 *
 * Because an inline ternary is untestable. The call site is inside
 * `handleChatCommand`, a handler that needs a live agent, a database row and a
 * message bus, so no test can reach the expression -- a mapping written there
 * is a mapping nothing can pin. That is not hypothetical: the previous inline
 * ternary mapped `bypassPermissions` to `acceptEdits` and `auto` to `plan`, and
 * both were wrong, and nothing failed.
 *
 * ## Why it is DERIVED, not restated
 *
 * `toExternalPermissionMode` reads `PERMISSION_MODE_CONFIG[mode].external`, the
 * repository's own declaration of what each internal mode is called externally.
 * Deriving from it means a mode added to that table cannot drift out of sync
 * with what gets recorded, and it means this file states no opinion the policy
 * module does not already hold.
 *
 * The two mappings it corrects:
 *
 *  - `bypassPermissions` recorded as `acceptEdits`. `PermissionPolicyMode`
 *    carries `bypassPermissions` itself, so the recorded policy was strictly
 *    weaker than the mode actually in force.
 *  - `auto` recorded as `plan`. `auto` default-allows workspace-confined
 *    actions and asks for the rest; `plan` means read-only planning. The
 *    policy module already declares `auto`'s external name to be `default`.
 *
 * ## What this does NOT do
 *
 * Enforce anything. The engine asks `ports.approval.authorize` for every call
 * with no mode shortcut and reads this value only to stamp
 * `ApprovalRequest.permissionMode`; the decision is the entry's
 * `askApproval` -> `requestPermission` bridge against the untranslated
 * `agentMode`. This is the RECORD, not the decision.
 */
export function manifestPermissionMode(
  agentMode: AgentPermissionMode,
): ExternalPermissionMode {
  return toExternalPermissionMode(agentMode);
}
