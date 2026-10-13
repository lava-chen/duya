/**
 * Plan 610 A8 shim — the permission policy moved to
 * `@duya/capabilities/permissions`. Pass-through so every existing
 * `../permissions/policy.js` import (BashTool security, PermissionsGate,
 * DuyaAgent, process bridges, tests) keeps resolving to the same symbols.
 */

export * from '@duya/capabilities/permissions';
