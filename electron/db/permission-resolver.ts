/**
 * permission-resolver.ts - electron 端新 session 的 permission profile 解析
 *
 * 严格规则:
 *   - 普通新 session (parentSessionId 为空): explicit > settings > 'default'
 *   - 派生 session (parentSessionId 有值, 无 trusted override): 继承父 row, 父不可读则 fail closed 为 'default'
 *   - 派生 session + trusted override: 走 explicit
 *   - **派生 session 路径绝不能读全局 settings** (防权限扩大)
 */

import { getDatabase } from './connection';
import {
  isValidProfile,
  settingsModeToProfile,
  type PermissionProfile,
} from '../lib/permission-profile';

const DEFAULT_PROFILE: PermissionProfile = 'default';

export interface ResolveOptions {
  /**
   * trusted internal caller 才允许派生 session 显式 override.
   * 普通 UI / IPC 不传. agent subagent 内部 fork 显式传 true.
   */
  isTrustedOverride?: boolean;
}

/**
 * Resolve permission profile for a new session row.
 *
 * 调用方必须在 INSERT 前调用本函数, 把返回值绑定到 SQL 占位符.
 * 禁止"先 INSERT 再 UPDATE"的两阶段写入, 那会引入瞬态不一致.
 */
export function resolvePermissionProfile(
  explicit: string | null | undefined,
  parentSessionId: string | null | undefined,
  options: ResolveOptions = {},
): PermissionProfile {
  // 1. 派生 session: 显式 override 仅当 trusted
  if (parentSessionId && isValidProfile(explicit) && options.isTrustedOverride) {
    return explicit;
  }

  // 2. 派生 session: 继承父, 父不可读则 fail closed
  if (parentSessionId) {
    return readParentProfileOrDefault(parentSessionId);
  }

  // 3. 普通新 session: explicit > settings > default
  if (isValidProfile(explicit)) return explicit;
  return readDefaultFromSettings();
}

function readParentProfileOrDefault(parentSessionId: string): PermissionProfile {
  try {
    const db = getDatabase();
    if (!db) return DEFAULT_PROFILE;
    const row = db
      .prepare('SELECT permission_profile FROM chat_sessions WHERE id = ?')
      .get(parentSessionId) as { permission_profile?: string | null } | undefined;
    const parentProfile = row?.permission_profile;
    if (isValidProfile(parentProfile)) return parentProfile;
    return DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

function readDefaultFromSettings(): PermissionProfile {
  try {
    const db = getDatabase();
    if (!db) return DEFAULT_PROFILE;
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'permissionMode'")
      .get() as { value?: string } | undefined;
    return settingsModeToProfile(row?.value);
  } catch {
    return DEFAULT_PROFILE;
  }
}
