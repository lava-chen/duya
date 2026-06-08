/**
 * usePermissions.ts - Frontend hook for handling permission requests
 *
 * This hook manages:
 * - Tracking pending permission requests from SSE events
 * - Sending permission decisions to the API
 * - Auto-approving for full_access permission profile
 * - Surfacing permission requests as system notifications with Allow/Deny
 *   actions so the user can decide from the OS tray (see
 *   notification:action IPC + showPermissionNotification).
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { PermissionRequestEvent } from '@/types/stream';
import { resolvePermission } from '@/lib/agent-sse-client';
import { subscribeToPhase, getSnapshot } from '@/lib/stream-session-manager';
import { showPermissionNotification } from '@/lib/notification';

export interface UsePermissionsOptions {
  /** Session ID for permission resolution forwarding */
  sessionId?: string;
  /** Permission profile - 'full_access' skips prompts, 'auto' uses YOLO classifier */
  permissionProfile?: 'default' | 'auto' | 'full_access';
  /** Callback when permission is resolved */
  onPermissionResolved?: (decision: 'allow' | 'deny', request: PermissionRequestEvent) => void;
  /**
   * When true (default) and the document is hidden, the hook will surface
   * pending permission requests as OS notifications with Allow/Deny
   * actions. Set to false in tests or when running purely in-renderer.
   */
  systemNotify?: boolean;
}

export interface UsePermissionsReturn {
  /** Current pending permission request */
  pendingPermission: PermissionRequestEvent | null;
  /** The decision that was made for the last permission */
  permissionResolved: 'allow' | 'deny' | null;
  /** Respond to a permission request */
  respondToPermission: (
    decision: 'allow' | 'allow_session' | 'deny',
    updatedInput?: Record<string, unknown>,
    denyMessage?: string
  ) => Promise<void>;
  /** Clear the pending permission state */
  clearPermission: () => void;
  /** Handle incoming permission request events from SSE */
  handlePermissionRequest: (request: PermissionRequestEvent) => void;
}

/**
 * Hook for handling permission requests from the agent
 */
export function usePermissions(options: UsePermissionsOptions = {}): UsePermissionsReturn {
  const { sessionId, permissionProfile = 'default', onPermissionResolved, systemNotify = true } = options;

  // Track pending permission request
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  // Track the resolved decision
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);

  // Ref to track if we're waiting for API response
  const waitingRef = useRef(false);

  // Auto-clear permission state after a delay when resolved
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear permission state after showing resolved status briefly
  const clearPermission = useCallback(() => {
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
    }
    clearTimeoutRef.current = setTimeout(() => {
      setPendingPermission(null);
      setPermissionResolved(null);
    }, 2000);
  }, []);

  // Respond to a permission request
  const respondToPermission = useCallback(
    async (
      decision: 'allow' | 'allow_session' | 'deny',
      updatedInput?: Record<string, unknown>,
      denyMessage?: string
    ): Promise<void> => {
      if (!pendingPermission) return;

      // Prevent multiple responses
      if (waitingRef.current) return;

      // Guard: don't send permission to a session that is no longer active
      if (sessionId) {
        const snapshot = getSnapshot(sessionId);
        if (snapshot && snapshot.phase !== 'awaiting_permission') {
          console.warn('[usePermissions] Session no longer awaiting permission, clearing stale prompt');
          setPendingPermission(null);
          setPermissionResolved(null);
          return;
        }
      }

      waitingRef.current = true;

      try {
        const mappedDecision =
          decision === 'allow_session' ? 'allow_for_session' : decision;

        if (!sessionId) {
          console.warn('[usePermissions] Missing sessionId, cannot resolve permission.');
          return;
        }

        await resolvePermission(
          sessionId,
          pendingPermission.id,
          mappedDecision as 'allow' | 'deny' | 'allow_once' | 'allow_for_session',
          {
            ...(updatedInput ? { updatedInput } : {}),
            ...(denyMessage ? { message: denyMessage } : {}),
          }
        );

        // Update local state
        setPermissionResolved(decision === 'allow_session' ? 'allow' : decision);

        // Notify callback
        onPermissionResolved?.(
          decision === 'allow_session' ? 'allow' : decision,
          pendingPermission
        );

        // Auto-clear after showing status
        clearPermission();
      } catch (error) {
        console.error('[usePermissions] Error sending permission decision:', error);
      } finally {
        waitingRef.current = false;
      }
    },
    [pendingPermission, onPermissionResolved, clearPermission, sessionId]
  );

  // Track the last permission id we accepted. SSE reconnect and agent
  // replay can deliver the same id twice; we must not reset the user's
  // in-flight decision (waitingRef, permissionResolved) on a duplicate.
  // When the active session changes, reset the ref so a new session's
  // permission id is treated as a fresh prompt even if it happens to
  // collide with a previous session's id.
  const lastSeenIdRef = useRef<string | null>(null);
  useEffect(() => {
    lastSeenIdRef.current = null;
  }, [sessionId]);

  // Handle permission request events from SSE
  // This should be called by the stream subscription when a permission_request event arrives
  const handlePermissionRequest = useCallback((request: PermissionRequestEvent) => {
    if (lastSeenIdRef.current === request.id) {
      // B5: same permission id replayed. Leave UI state alone so the
      // user's in-progress decision is not clobbered. (The first POST in
      // flight will reach the agent; the agent's B4 fix will idempotently
      // resolve the entry.)
      return;
    }
    lastSeenIdRef.current = request.id;

    if (permissionProfile === 'full_access' && sessionId) {
      waitingRef.current = true;
      setPendingPermission(null);
      setPermissionResolved(null);

      void resolvePermission(sessionId, request.id, 'allow')
        .then(() => {
          onPermissionResolved?.('allow', request);
        })
        .catch((error) => {
          console.error('[usePermissions] Error auto-approving permission:', error);
          setPendingPermission(request);
          setPermissionResolved(null);
        })
        .finally(() => {
          waitingRef.current = false;
        });
      return;
    }

    setPendingPermission(request);
    setPermissionResolved(null);
    waitingRef.current = false;

    // Surface as a system notification with Allow / Deny actions so the
    // user can decide from the OS tray when the window is hidden.
    // Guarded by document.visibilityState to avoid double-prompting when
    // the in-app modal is already on screen.
    if (systemNotify && typeof document !== 'undefined' && document.visibilityState === 'hidden' && sessionId) {
      void showPermissionNotification({
        sessionId,
        permissionId: request.id,
        toolName: request.toolName ?? 'tool',
        body: typeof request.toolInput === 'string'
          ? `Allow ${request.toolName}? ${request.toolInput}`.slice(0, 200)
          : `Allow ${request.toolName ?? 'tool'} to run?`,
      });
    }
  }, [systemNotify, sessionId, permissionProfile, onPermissionResolved]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
      }
    };
  }, []);


  // Bridge OS notification actions back to the in-app permission flow.
  //
  // The main process sends `notification:action` with type 'permission'
  // and an actionId of 'allow' / 'deny' (or '__reply' for the inline
  // reply text field on macOS). We resolve it against the currently
  // pending permission — if a decision is already in flight or the
  // session has moved on, the IPC payload is dropped.
  useEffect(() => {
    if (!systemNotify) return;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.onNotificationAction) return;

    const unsubscribe = api.onNotificationAction((data) => {
      if (data.type !== 'permission') return;
      if (!data.permissionId || data.permissionId !== lastSeenIdRef.current) return;
      if (data.sessionId && sessionId && data.sessionId !== sessionId) return;
      if (waitingRef.current || !pendingPermission) return;

      if (data.actionId === 'allow') {
        void respondToPermission('allow');
      } else if (data.actionId === 'deny') {
        void respondToPermission('deny', undefined, data.reply || 'Denied from notification');
      } else if (data.actionId === '__reply' && data.reply) {
        // Treat a typed reply in the permission notification as a deny
        // with explanatory message — there is no in-place "edit input"
        // we could re-submit to the tool from the tray.
        void respondToPermission('deny', undefined, data.reply);
      }
    });
    return unsubscribe;
  }, [systemNotify, sessionId, pendingPermission, respondToPermission]);

  // Dismiss stale permission prompt when session phase changes to a terminal
  // state (e.g. session completed while permission was still pending in UI).
  //
  // CRITICAL: only clear when phase is *terminal* (completed/error/idle).
  // During `starting`/`streaming`/`persisting` we leave the prompt alone —
  // those transitions can be transient (the model resumed emitting text
  // after we sent the decision, B8's fix prevents the manager itself
  // from clearing state, but the phase subscriber can still see the
  // notify and must not race against an in-flight user click).
  useEffect(() => {
    if (!sessionId) return;

    const TERMINAL_PHASES = new Set(['completed', 'error', 'idle']);
    const unsub = subscribeToPhase(sessionId, (phase: string) => {
      if (TERMINAL_PHASES.has(phase) && pendingPermission && !waitingRef.current) {
        console.log('[usePermissions] Phase terminal', phase, '- clearing stale permission');
        setPendingPermission(null);
        setPermissionResolved(null);
      }
    });

    return unsub;
  }, [sessionId, pendingPermission]);

  return {
    pendingPermission,
    permissionResolved,
    respondToPermission,
    clearPermission,
    // Expose the handler for SSE integration
    handlePermissionRequest,
  };
}
