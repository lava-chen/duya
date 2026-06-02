/**
 * permission-profile.ts - 跨层 permission mode 映射的单一来源 (electron 端)
 *
 * 三种命名空间, 三个互不相同的字符串字面值:
 *   - Settings (AppSettings.permissionMode): "default" | "bypass" | "auto"
 *   - DB profile (chat_sessions.permission_profile): "default" | "auto" | "full_access"
 *   - Agent internal mode: "default" | "auto" | "bypassPermissions"
 *
 * renderer 端 src/lib/permission-profile.ts 是本文件的逐字符镜像, 不可与本文件漂移.
 * 同步由 src/lib/__tests__/permission-profile.contract.test.ts 强制.
 */

export type PermissionProfile = 'default' | 'auto' | 'full_access';
export type AgentPermissionMode = 'default' | 'auto' | 'bypassPermissions';
export type SettingsPermissionMode = 'default' | 'bypass' | 'auto';

export const VALID_PROFILES: readonly PermissionProfile[] = ['default', 'auto', 'full_access'] as const;
export const VALID_AGENT_MODES: readonly AgentPermissionMode[] = ['default', 'auto', 'bypassPermissions'] as const;

export function isValidProfile(p: unknown): p is PermissionProfile {
  return p === 'default' || p === 'auto' || p === 'full_access';
}

export function isValidAgentMode(m: unknown): m is AgentPermissionMode {
  return m === 'default' || m === 'auto' || m === 'bypassPermissions';
}

/** Settings.permissionMode (string) → DB profile. 未知值降级为 'default'. */
export function settingsModeToProfile(mode: string | null | undefined): PermissionProfile {
  if (mode === 'bypass') return 'full_access';
  if (mode === 'auto') return 'auto';
  if (mode === 'default') return 'default';
  return 'default';
}

/** DB profile → agent internal mode. 未知值降级为 'default'. */
export function profileToAgentMode(profile: string | null | undefined): AgentPermissionMode {
  if (profile === 'full_access') return 'bypassPermissions';
  if (profile === 'auto') return 'auto';
  return 'default';
}
