/**
 * permission-profile.ts - renderer 端跨层 permission mode 映射
 *
 * 此文件是 electron/lib/permission-profile.ts 的逐字符镜像. 任何修改两边必须同步.
 * 同步由 src/lib/__tests__/permission-profile.contract.test.ts 强制.
 *
 * 不 import 任何 electron/node 专属 API, 保持平台无关.
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
