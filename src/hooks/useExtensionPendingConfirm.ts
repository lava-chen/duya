import { useState, useCallback, useEffect } from 'react';

export interface PendingExtensionInfo {
  extId: string;
  extName: string;
  version: string | null;
}

function getElectronAPI() {
  return (window as unknown as {
    electronAPI?: {
      browserExtension?: {
        onPendingConnection: (callback: (info: PendingExtensionInfo) => void) => () => void;
        approveConnection: (extId: string) => Promise<{ success: boolean }>;
        denyConnection: (extId: string) => Promise<{ success: boolean }>;
      };
    };
  }).electronAPI;
}

export function useExtensionPendingConfirm(): {
  pending: PendingExtensionInfo | null;
  approve: () => Promise<void>;
  deny: () => Promise<void>;
} {
  const [pending, setPending] = useState<PendingExtensionInfo | null>(null);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.browserExtension?.onPendingConnection) return;

    const unsubscribe = api.browserExtension.onPendingConnection((info) => {
      setPending(info);
    });

    return unsubscribe;
  }, []);

  const approve = useCallback(async () => {
    if (!pending) return;
    const api = getElectronAPI();
    if (api?.browserExtension?.approveConnection) {
      await api.browserExtension.approveConnection(pending.extId);
    }
    setPending(null);
  }, [pending]);

  const deny = useCallback(async () => {
    if (!pending) return;
    const api = getElectronAPI();
    if (api?.browserExtension?.denyConnection) {
      await api.browserExtension.denyConnection(pending.extId);
    }
    setPending(null);
  }, [pending]);

  return { pending, approve, deny };
}