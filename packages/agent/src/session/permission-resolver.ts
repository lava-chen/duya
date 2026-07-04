/**
 * permission-resolver.ts - agent 端新 session 的 permission profile 解析
 *
 * 规则与 electron 端一致, 但 agent 端 **无 settings 表**, 因此:
 *   - 普通 new (parentSessionId 为空): explicit > DEFAULT_PROFILE
 *   - 派生: trusted explicit > parent > DEFAULT_PROFILE
 *   - 派生 session 路径绝不能读 settings (无表, 也无意义)
 *
 * 调用方通常应在 IPC 模式下走 main 进程的 query 层 (那里有 settings 表).
 * 本 resolver 主要服务 agent 直接 SQL 路径 (USE_IPC_MODE=false).
 *
 * DEFAULT_PROFILE = 'auto' (YOLO): 与 duya 新装默认一致. 派生 session 父不可读
 * 时仍会落到 auto, 与 "新装默认 YOLO" 的产品策略保持一致.
 */

import { getSession } from './db.js';

export type PermissionProfile = 'default' | 'auto' | 'full_access';

export const DEFAULT_PROFILE: PermissionProfile = 'auto';

export interface ResolveOptions {
  isTrustedOverride?: boolean;
}

export function isValidProfile(p: unknown): p is PermissionProfile {
  return p === 'default' || p === 'auto' || p === 'full_access';
}

export function resolveAgentPermissionProfile(
  explicit: string | null | undefined,
  parentSessionId: string | null | undefined,
  options: ResolveOptions = {},
): PermissionProfile {
  // 1. 派生 + trusted explicit
  if (parentSessionId && isValidProfile(explicit) && options.isTrustedOverride) {
    return explicit;
  }

  // 2. 派生: 继承父, 父不可读则 fail closed
  if (parentSessionId) {
    try {
      const parent = getSession(parentSessionId);
      const parentProfile = parent?.permission_profile;
      if (isValidProfile(parentProfile)) return parentProfile;
      return DEFAULT_PROFILE;
    } catch {
      return DEFAULT_PROFILE;
    }
  }

  // 3. 普通 new: explicit > 'default' (agent 端无 settings 表)
  if (isValidProfile(explicit)) return explicit;
  return DEFAULT_PROFILE;
}
