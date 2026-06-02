// useBrowserExtension.ts - Hook for checking browser extension status via IPC

import { useState, useEffect, useCallback, useRef } from 'react';

export type ExtensionStatus = 'checking' | 'connected' | 'disconnected' | 'error';

export interface ExtensionHealth {
  status: 'ok' | 'unavailable';
  extensionConnected: boolean;
  daemonRunning: boolean;
  extensionVersion: string | null;
  extensionName: string | null;
  extensionId: string | null;
  pendingExtensionApproval: {
    extensionId: string | null;
    extensionName: string;
    extensionVersion: string | null;
    requestedAt: number;
  } | null;
  pendingCommands: number;
  port: number;
}

export interface UseBrowserExtensionReturn {
  status: ExtensionStatus;
  health: ExtensionHealth | null;
  isInstalled: boolean;
  checkExtension: () => Promise<void>;
  lastChecked: Date | null;
  storeAvailable: boolean | null;
  checkStoreAvailability: () => Promise<boolean>;
}

const CHECK_INTERVAL = 30000; // Check every 30 seconds

// Timeout for store availability check (5 seconds)
const STORE_CHECK_TIMEOUT = 5000;

function getElectronAPI() {
  return (
    window as unknown as {
      electronAPI?: {
        browserExtension?: {
          getStatus: () => Promise<{ success: boolean; status?: Record<string, unknown>; error?: string }>;
          approvePending?: () => Promise<{ success: boolean; status?: Record<string, unknown>; error?: string }>;
          denyPending?: () => Promise<{ success: boolean; status?: Record<string, unknown>; error?: string }>;
        };
      };
    }
  ).electronAPI;
}

/**
 * Check if Chrome Web Store is accessible.
 *
 * We use a lightweight image probe instead of fetch() because Chrome Web Store
 * returns 403 for no-cors HEAD requests (causing noisy console errors).
 * An Image load attempt is truly silent on failure and works with no-cors.
 */
function checkStoreAvailabilityInternal(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!navigator.onLine) {
      resolve(false);
      return;
    }

    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      resolve(false);
    }, STORE_CHECK_TIMEOUT);

    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };

    // Use a favicon from the Chrome Web Store domain.
    // The favicon is a small, always-available resource on the same origin.
    img.src = 'https://chromewebstore.google.com/favicon.ico';
  });
}

/**
 * Hook to check browser extension connection status via Electron IPC
 * Queries the main process which directly checks daemon state
 */
export function useBrowserExtension(
  options: { autoCheck?: boolean; interval?: number } = {}
): UseBrowserExtensionReturn {
  const { autoCheck = true, interval = CHECK_INTERVAL } = options;

  const [status, setStatus] = useState<ExtensionStatus>('checking');
  const [health, setHealth] = useState<ExtensionHealth | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [storeAvailable, setStoreAvailable] = useState<boolean | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const checkStoreAvailability = useCallback(async (): Promise<boolean> => {
    const available = await checkStoreAvailabilityInternal();
    setStoreAvailable(available);
    return available;
  }, []);

  const checkExtension = useCallback(async () => {
    setStatus('checking');

    const electronAPI = getElectronAPI();
    if (!electronAPI?.browserExtension?.getStatus) {
      // Fallback: if no IPC API available (e.g. running in browser), show disconnected
      setStatus('disconnected');
      setHealth({
        status: 'unavailable',
        extensionConnected: false,
        daemonRunning: false,
        extensionVersion: null,
        extensionName: null,
        extensionId: null,
        pendingExtensionApproval: null,
        pendingCommands: 0,
        port: 19825,
      });
      setLastChecked(new Date());
      return;
    }

    try {
      const result = await electronAPI.browserExtension.getStatus();

      if (!result.success || !result.status) {
        setStatus('error');
        setHealth({
          status: 'unavailable',
          extensionConnected: false,
          daemonRunning: false,
          extensionVersion: null,
          extensionName: null,
          extensionId: null,
          pendingExtensionApproval: null,
          pendingCommands: 0,
          port: 19825,
        });
        setLastChecked(new Date());
        return;
      }

      const s = result.status;
      const daemonRunning = Boolean(s.daemonRunning);
      const extensionConnected = Boolean(s.extensionConnected);

      const healthData: ExtensionHealth = {
        status: daemonRunning && extensionConnected ? 'ok' : 'unavailable',
        extensionConnected,
        daemonRunning,
        extensionVersion: typeof s.extensionVersion === 'string' ? s.extensionVersion : null,
        extensionName: typeof s.extensionName === 'string' ? s.extensionName : null,
        extensionId: typeof s.extensionId === 'string' ? s.extensionId : null,
        pendingExtensionApproval:
          s.pendingExtensionApproval && typeof s.pendingExtensionApproval === 'object'
            ? {
                extensionId: typeof (s.pendingExtensionApproval as Record<string, unknown>).extensionId === 'string'
                  ? (s.pendingExtensionApproval as Record<string, unknown>).extensionId as string
                  : null,
                extensionName: typeof (s.pendingExtensionApproval as Record<string, unknown>).extensionName === 'string'
                  ? (s.pendingExtensionApproval as Record<string, unknown>).extensionName as string
                  : 'Unknown Extension',
                extensionVersion: typeof (s.pendingExtensionApproval as Record<string, unknown>).extensionVersion === 'string'
                  ? (s.pendingExtensionApproval as Record<string, unknown>).extensionVersion as string
                  : null,
                requestedAt: typeof (s.pendingExtensionApproval as Record<string, unknown>).requestedAt === 'number'
                  ? (s.pendingExtensionApproval as Record<string, unknown>).requestedAt as number
                  : Date.now(),
              }
            : null,
        pendingCommands: typeof s.pendingCommands === 'number' ? s.pendingCommands : 0,
        port: typeof s.port === 'number' ? s.port : 19825,
      };

      setHealth(healthData);

      if (!daemonRunning) {
        setStatus('error');
      } else if (extensionConnected) {
        setStatus('connected');
      } else {
        setStatus('disconnected');
      }
      setLastChecked(new Date());
    } catch (error) {
      setStatus('error');
      setHealth({
        status: 'unavailable',
        extensionConnected: false,
        daemonRunning: false,
        extensionVersion: null,
        extensionName: null,
        extensionId: null,
        pendingExtensionApproval: null,
        pendingCommands: 0,
        port: 19825,
      });
      setLastChecked(new Date());
    }
  }, []);

  useEffect(() => {
    // Initial check
    checkExtension();

    // Set up polling if autoCheck is enabled
    if (autoCheck) {
      intervalRef.current = setInterval(checkExtension, interval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [checkExtension, autoCheck, interval]);

  return {
    status,
    health,
    isInstalled: status === 'connected',
    checkExtension,
    lastChecked,
    storeAvailable,
    checkStoreAvailability,
  };
}

/**
 * Hook to manage extension install prompt visibility
 * Remembers user's preference to not show again
 */
export function useExtensionPrompt(
  storageKey = 'duya_extension_prompt_dismissed'
): {
  showPrompt: boolean;
  dismissPrompt: () => void;
  resetPrompt: () => void;
} {
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // Check if user has dismissed the prompt
    const dismissed = localStorage.getItem(storageKey);
    if (!dismissed) {
      setShowPrompt(true);
    }
  }, [storageKey]);

  const dismissPrompt = useCallback(() => {
    localStorage.setItem(storageKey, 'true');
    setShowPrompt(false);
  }, [storageKey]);

  const resetPrompt = useCallback(() => {
    localStorage.removeItem(storageKey);
    setShowPrompt(true);
  }, [storageKey]);

  return { showPrompt, dismissPrompt, resetPrompt };
}
