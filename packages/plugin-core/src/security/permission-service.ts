/**
 * PermissionService — audit-only ledger of permissions granted to a
 * plugin at install time.
 *
 * Runtime interception lives in
 * `packages/agent/src/mcp/permission-gate.ts:evaluateMcpToolPermission`.
 * This service is intentionally NOT consulted on the hot path; it
 * exists so:
 *   - The UI can show "you granted this plugin N permissions" surfaces.
 *   - `PluginManager.remove` has a single point of revocation
 *     (`revokeAllPermissions`).
 *
 * The historical `confirmPluginPermissions` method never confirmed
 * anything — it was a write-only ledger entry. It has been renamed to
 * `recordGrantedPermissions` to make the actual semantics explicit.
 * No deprecation alias is kept; the only known callers (audit on
 * 2026-06-04) are in `electron/plugins/PluginManager.ts`.
 */
import type { PluginTrustInfo, PluginTrustLevel } from './trust-engine';

export interface PermissionRequest {
  name: string;
  scope?: 'plugin' | 'project' | 'system';
  domains?: string[];
  paths?: string[];
}

export interface GrantedPermission extends PermissionRequest {
  grantedAt: number;
  expiresAt?: number;
  revoked: boolean;
  revokedAt?: number;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export class PermissionService {
  private grantedPermissions: Map<string, GrantedPermission[]> = new Map();

  getPluginPermissions(pluginId: string): GrantedPermission[] {
    return this.grantedPermissions.get(pluginId) ?? [];
  }

  async recordGrantedPermissions(
    pluginId: string,
    permissions: PermissionRequest[],
  ): Promise<boolean> {
    const existing = this.getPluginPermissions(pluginId);
    const newPermissions: GrantedPermission[] = permissions.map((p) => ({
      ...p,
      grantedAt: Date.now(),
      revoked: false,
    }));

    this.grantedPermissions.set(pluginId, [...existing, ...newPermissions]);
    return true;
  }

  checkPermission(
    pluginId: string,
    _trust: PluginTrustInfo,
    request: PermissionRequest,
  ): PermissionCheckResult {
    const grants = this.getPluginPermissions(pluginId);
    const matching = grants.filter(
      (g) => g.name === request.name && !g.revoked,
    );

    if (matching.length === 0) {
      return {
        allowed: false,
        reason: `Permission "${request.name}" not granted for plugin "${pluginId}"`,
      };
    }

    for (const grant of matching) {
      if (grant.expiresAt && grant.expiresAt < Date.now()) {
        continue;
      }

      if (request.scope && grant.scope && grant.scope !== request.scope) {
        continue;
      }

      if (request.domains && grant.domains) {
        const allowed = request.domains.every((d) => grant.domains!.includes(d));
        if (!allowed) continue;
      }

      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Permission "${request.name}" scope mismatch for plugin "${pluginId}"`,
    };
  }

  async requestTemporaryPermission(
    pluginId: string,
    permission: PermissionRequest,
    durationMs: number,
  ): Promise<GrantedPermission | null> {
    const grant: GrantedPermission = {
      ...permission,
      grantedAt: Date.now(),
      expiresAt: Date.now() + durationMs,
      revoked: false,
    };

    const existing = this.getPluginPermissions(pluginId);
    this.grantedPermissions.set(pluginId, [...existing, grant]);
    return grant;
  }

  revokePermission(pluginId: string, permissionName: string): void {
    const grants = this.getPluginPermissions(pluginId);
    const updated = grants.map((g) =>
      g.name === permissionName
        ? { ...g, revoked: true, revokedAt: Date.now() }
        : g,
    );
    this.grantedPermissions.set(pluginId, updated);
  }

  revokeAllPermissions(pluginId: string): void {
    const grants = this.getPluginPermissions(pluginId);
    const updated = grants.map((g) => ({
      ...g,
      revoked: true,
      revokedAt: Date.now(),
    }));
    this.grantedPermissions.set(pluginId, updated);
  }

  isExpired(grant: GrantedPermission): boolean {
    return !!grant.expiresAt && grant.expiresAt < Date.now();
  }

  revokeExpired(): number {
    let count = 0;
    for (const [pluginId, grants] of this.grantedPermissions) {
      const updated = grants.map((g) =>
        !g.revoked && this.isExpired(g)
          ? { ...g, revoked: true, revokedAt: Date.now() }
          : g,
      );
      const revokedCount = updated.filter(
        (g, i) => g.revoked && !grants[i].revoked,
      ).length;
      count += revokedCount;
      this.grantedPermissions.set(pluginId, updated);
    }
    return count;
  }
}