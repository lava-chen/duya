/**
 * `@duya/capabilities/permissions` — the permission vocabulary and policy
 * (moved verbatim from `packages/agent/src/permissions/`).
 *
 * `types.ts` is the permission vocabulary (modes, rules, decisions);
 * `policy.ts` is the enforcement policy (path safety, command analysis,
 * mode config). The agent keeps byte-compatible shims at the old paths, so
 * every existing `../permissions/policy.js` import keeps working — the
 * module graph just points at this package now.
 */

export * from './types.js';
export * from './policy.js';
