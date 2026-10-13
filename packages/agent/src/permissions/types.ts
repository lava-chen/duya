/**
 * Plan 610 A8 shim — the permission vocabulary moved to
 * `@duya/capabilities/permissions`. Pass-through so every existing
 * `../permissions/types.js` import keeps resolving to the same types.
 */

export * from '@duya/capabilities/permissions';
