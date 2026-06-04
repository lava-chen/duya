// packages/plugin-core/tests/security/permission-service.test.ts
// Plan 101 — Phase 0: failing baseline tests pinning the post-Phase-2
// contract for the audit-only PermissionService ledger.
//
// Tests will fail against the current code because:
// - `recordGrantedPermissions` does not exist (renamed in Phase 2 from
//   `confirmPluginPermissions`).
// - `getUserOverride` / `setUserOverride` / `clearUserOverride` on
//   TrustEngine must be removed in Phase 2; the "compile-time enforced"
//   tests below import from the modules and assert by-name that those
//   methods are gone.

import { describe, it, expect } from 'vitest';
import * as permissionServiceModule from '../../src/security/permission-service.js';
import * as trustEngineModule from '../../src/security/trust-engine.js';

describe('PermissionService — audit-only ledger (post-Phase-2 contract)', () => {
  it('exposes recordGrantedPermissions as a function', () => {
    // Renamed from `confirmPluginPermissions` in Phase 2.
    const svc = new permissionServiceModule.PermissionService();
    expect(typeof (svc as unknown as { recordGrantedPermissions?: unknown }).recordGrantedPermissions).toBe('function');
  });

  it('recordGrantedPermissions adds entries', async () => {
    const svc = new permissionServiceModule.PermissionService();

    const before = svc.getPluginPermissions('plugin-a').length;
    await svc.recordGrantedPermissions('plugin-a', [{ name: 'workspace.read' }]);
    const after = svc.getPluginPermissions('plugin-a').length;

    expect(after).toBe(before + 1);
    expect(svc.getPluginPermissions('plugin-a').some((g) => g.name === 'workspace.read')).toBe(true);
  });

  it('revokeAllPermissions clears all entries', async () => {
    const svc = new permissionServiceModule.PermissionService();

    await svc.recordGrantedPermissions('plugin-b', [{ name: 'workspace.read' }, { name: 'workspace.write' }]);
    expect(svc.getPluginPermissions('plugin-b').length).toBe(2);

    svc.revokeAllPermissions('plugin-b');
    // After revokeAllPermissions, every grant must be marked revoked.
    const remaining = svc.getPluginPermissions('plugin-b').filter((g) => !g.revoked);
    expect(remaining.length).toBe(0);
  });
});

describe('TrustEngine — user override methods removed (post-Phase-2 contract)', () => {
  it('TrustEngine does not expose getUserOverride', () => {
    // After Phase 2 the public surface must not have these methods.
    const engine = new trustEngineModule.TrustEngine();
    expect((engine as unknown as { getUserOverride?: unknown }).getUserOverride).toBeUndefined();
  });

  it('TrustEngine does not expose setUserOverride', () => {
    const engine = new trustEngineModule.TrustEngine();
    expect((engine as unknown as { setUserOverride?: unknown }).setUserOverride).toBeUndefined();
  });

  it('TrustEngine does not expose clearUserOverride', () => {
    const engine = new trustEngineModule.TrustEngine();
    expect((engine as unknown as { clearUserOverride?: unknown }).clearUserOverride).toBeUndefined();
  });
});
