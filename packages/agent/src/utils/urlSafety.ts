/**
 * urlSafety.ts — re-export shim.
 *
 * The implementation now lives in `@duya/browser` (plan 583, seam A):
 * the browser engine is the primary consumer of URL safety policy, and
 * the file is self-contained (its only import is `dns/promises`).
 *
 * This shim keeps the single historical import path working so the two
 * non-browser consumers — `src/session/db.ts` and
 * `src/process/agent-process-entry.ts` — need no change, and so there is
 * still exactly one implementation.
 */

export {
  resolvePublicIP,
  isSafeUrl,
  isSafeUrlSync,
  isCDNImageUrl,
  validateRedirectUrl,
} from '@duya/browser';
export type { URLSafetyResult } from '@duya/browser';
