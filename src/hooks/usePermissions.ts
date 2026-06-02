/**
 * usePermissions.ts - Frontend hook for handling permission requests
 *
 * This hook manages:
 * - Tracking pending permission requests from SSE events
 * - Sending permission decisions to the API
 * - Auto-approving for full_access permission profile
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { PermissionRequestEvent } from '@/types/stream';
import { resolvePermission } from '@/lib/agent-sse-client';
import { subscribeToPhase, getSnapshot } from '@/lib/stream-session-manager';

export interface UsePermissionsOptions {
  /** Session ID for permission resolution forwarding */
  sessionId?: string;
  /** Permission profile - 'full_access' skips prompts, 'auto' uses YOLO classifier */
  permissionProfile?: 'default' | 'auto' | 'full_access';
  /** Callback when permission is resolved */
  onPermissionResolved?: (decision: 'allow' | 'deny', request: PermissionRequestEvent) => void;
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
  const { sessionId, permissionProfile = 'default', onPermissionResolved } = options;

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

  // Handle permission request events from SSE
  // This should be called by the stream subscription when a permission_request event arrives
  const handlePermissionRequest = useCallback((request: PermissionRequestEvent) => {
    // Clear any existing permission state
    setPendingPermission(request);
    setPermissionResolved(null);
    waitingRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
      }
    };
  }, []);

  // Auto-approve when full_access is active
  useEffect(() => {
    if (
      permissionProfile === 'full_access' &&
      pendingPermission &&
      !permissionResolved &&
      !waitingRef.current
    ) {
      // Auto-approve after a small delay to show the UI briefly
      const timer = setTimeout(() => {
        respondToPermission('allow');
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [permissionProfile, pendingPermission, permissionResolved, respondToPermission]);

  // Dismiss stale permission prompt when session phase changes away from awaiting_permission
  // (e.g. session completed while permission was still pending in UI)
  useEffect(() => {
    if (!sessionId) return;

    const unsub = subscribeToPhase(sessionId, (phase: string) => {
      if (phase !== 'awaiting_permission' && pendingPermission && !waitingRef.current) {
        console.log('[usePermissions] Phase changed to', phase, '- clearing stale permission');
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
