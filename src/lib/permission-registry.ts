/**
 * Permission Registry - Manages pending permission requests
 *
 * This module provides an in-memory registry for pending permission requests.
 * It uses globalThis to ensure the Map is shared across module instances.
 *
 * Timeout: 5 minutes per request
 * Auto-deny on abort signal (client disconnect / stop button)
 */

/**
 * Get or create an AbortController for a session's permission operations.
 */
export function getPermissionAbortController(sessionId: string): AbortController {
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  const key = `__permissionAbortController__${sessionId}`;
  const existing = global[key] as AbortController | undefined;
  if (!existing || existing.signal.aborted) {
    global[key] = new AbortController();
  }
  return global[key] as AbortController;
}

/**
 * Abort all pending permissions for a session.
 * Called when the stream is interrupted via the interrupt API.
 */
export function abortPendingPermissionsForSession(sessionId: string): void {
  const controller = getPermissionAbortController(sessionId);
  if (!controller.signal.aborted) controller.abort();
}

/**
 * Permission result type - returned when a permission request is resolved
 */
export type PermissionResult = {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
};

// Pending permission entry
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  createdAt: number;
  abortSignal?: AbortSignal;
  toolInput: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Use globalThis to ensure Map is shared across module instances
// across different module loads (e.g., in Vite dev HMR scenarios).
const globalKey = '__pendingPermissions__' as const;

function getMap(): Map<string, PendingPermission> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, PendingPermission>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, PendingPermission>;
}

/**
 * Helper to deny and remove a pending permission entry.
 */
function denyAndRemove(id: string, message: string, dbStatus: 'timeout' | 'aborted' = 'aborted') {
  const map = getMap();
  const entry = map.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.resolve({ behavior: 'deny', message });
  map.delete(id);
  // DB write for audit logging - failure should not affect in-memory path
  try {
    // Import db functions lazily to avoid circular dependencies
    const { resolvePermissionRequest } = require('./db');
    resolvePermissionRequest(id, dbStatus, { message });
  } catch {
    // DB write failure should not affect in-memory path
  }
}

/**
 * Register a pending permission request.
 * Returns a Promise that resolves when the user responds or after TIMEOUT_MS.
 *
 * @param id - Unique permission request ID
 * @param toolInput - The tool input that requires permission
 * @param abortSignal - Optional abort signal for auto-deny on client disconnect
 * @param sessionId - Session ID for session-level abort (interrupt API)
 * @returns Promise<PermissionResult> that resolves on user decision or timeout
 */
export function registerPendingPermission(
  id: string,
  toolInput: Record<string, unknown>,
  abortSignal?: AbortSignal,
  sessionId?: string,
): Promise<PermissionResult> {
  const map = getMap();

  return new Promise<PermissionResult>((resolve) => {
    // Per-request independent timer: auto-deny after TIMEOUT_MS
    const timer = setTimeout(() => {
      if (map.has(id)) {
        console.warn(`[permission-registry] Permission request ${id} timed out after ${TIMEOUT_MS / 1000}s`);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
        map.delete(id);
        try {
          const { resolvePermissionRequest } = require('./db');
          resolvePermissionRequest(id, 'timeout', { message: 'Permission request timed out' });
        } catch {
          // DB write failure should not affect in-memory path
        }
      }
    }, TIMEOUT_MS);

    map.set(id, {
      resolve,
      createdAt: Date.now(),
      abortSignal,
      toolInput,
      timer,
    });

    // Auto-deny if the abort signal fires (client disconnect)
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => denyAndRemove(id, 'Request aborted'), { once: true });
    }

    // Auto-deny if the session-level abort fires (interrupt API / stop button)
    if (sessionId) {
      const sessionAbortController = getPermissionAbortController(sessionId);
      if (!sessionAbortController.signal.aborted) {
        sessionAbortController.signal.addEventListener('abort', () => denyAndRemove(id, 'Request aborted'), { once: true });
      } else {
        // Already aborted, deny immediately
        denyAndRemove(id, 'Request aborted');
      }
    }
  });
}

/**
 * Resolve a pending permission request with the user's decision.
 * Returns true if the permission was found and resolved, false otherwise.
 *
 * @param id - Permission request ID
 * @param result - The permission result (allow/deny)
 * @returns true if found and resolved, false otherwise
 */
export function resolvePendingPermission(
  id: string,
  result: PermissionResult,
): boolean {
  const map = getMap();
  const entry = map.get(id);
  if (!entry) return false;

  clearTimeout(entry.timer);

  // If allowing without updatedInput, use the original tool input
  if (result.behavior === 'allow' && !result.updatedInput) {
    result = { ...result, updatedInput: entry.toolInput };
  }

  // Persist to DB for audit logging before resolving in-memory
  try {
    const { resolvePermissionRequest } = require('./db');
    const dbStatus = result.behavior === 'allow' ? 'allow' : 'deny';
    resolvePermissionRequest(id, dbStatus, {
      updatedPermissions: result.behavior === 'allow' ? (result.updatedPermissions as unknown[]) : undefined,
      updatedInput: result.behavior === 'allow' ? (result.updatedInput as Record<string, unknown>) : undefined,
      message: result.behavior === 'deny' ? result.message : undefined,
    });
  } catch {
    // DB write failure should not affect in-memory path
  }

  entry.resolve(result);
  map.delete(id);
  return true;
}
