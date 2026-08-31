"use client";

import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldIcon, XIcon, CheckIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/hooks/useTranslation';
import type { PermissionRequestEvent } from '@/types/stream';

interface GatewayPermissionCardProps {
  /** Session ID for the permission context */
  sessionId: string | null;
  /** Callback when user responds to permission */
  onPermissionResponse: (decision: 'allow' | 'deny') => void;
}

/**
 * Permission card for gateway UI - displays pending permission requests
 * and handles user responses for WeChat and other platform channels.
 */
export function GatewayPermissionCard({
  sessionId,
  onPermissionResponse,
}: GatewayPermissionCardProps) {
  const { t } = useTranslation();
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch pending permission from IPC
  const fetchPendingPermission = useCallback(async () => {
    if (!sessionId) return;
    
    try {
      const result = await window.electronAPI?.gateway?.getPendingPermission(sessionId);
      if (result) {
        setPendingPermission(result as PermissionRequestEvent);
      } else {
        setPendingPermission(null);
      }
    } catch (err) {
      console.error('Failed to fetch pending permission:', err);
      setPendingPermission(null);
    }
  }, [sessionId]);

  // Poll for pending permissions
  useEffect(() => {
    if (!sessionId) return;
    
    fetchPendingPermission();
    const interval = setInterval(fetchPendingPermission, 2000);
    return () => clearInterval(interval);
  }, [sessionId, fetchPendingPermission]);

  const handleAllow = useCallback(async () => {
    setLoading(true);
    try {
      await window.electronAPI?.gateway?.resolvePermission(sessionId!, 'allow');
      onPermissionResponse('allow');
      setPendingPermission(null);
    } catch (err) {
      console.error('Failed to allow permission:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, onPermissionResponse]);

  const handleDeny = useCallback(async () => {
    setLoading(true);
    try {
      await window.electronAPI?.gateway?.resolvePermission(sessionId!, 'deny');
      onPermissionResponse('deny');
      setPendingPermission(null);
    } catch (err) {
      console.error('Failed to deny permission:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, onPermissionResponse]);

  // Don't render if no pending permission
  if (!pendingPermission) return null;

  const toolName = pendingPermission.toolName || 'Unknown';
  const toolInput = pendingPermission.toolInput || {};
  
  // Format tool input for display
  const formatInput = (input: Record<string, unknown>): string => {
    if (input.command) return String(input.command);
    if (input.file_path) return String(input.file_path);
    if (input.path) return String(input.path);
    return JSON.stringify(input, null, 2).slice(0, 300);
  };

  const inputPreview = formatInput(toolInput);
  const isLongInput = inputPreview.length > 200;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.2 }}
        className="gateway-permission-card"
      >
        <div className="gateway-permission-header">
          <div className="gateway-permission-icon">
            <ShieldIcon size={18} />
          </div>
          <div className="gateway-permission-title">
            <span className="gateway-permission-label">权限请求</span>
            <span className="gateway-permission-tool">{toolName}</span>
          </div>
          <button
            type="button"
            className="gateway-permission-close"
            onClick={() => setPendingPermission(null)}
            aria-label="Dismiss"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="gateway-permission-body">
          <div className="gateway-permission-tool-input">
            <pre>{isLongInput ? inputPreview.slice(0, 200) + '…' : inputPreview}</pre>
          </div>
        </div>

        <div className="gateway-permission-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDeny}
            disabled={loading}
            className="gateway-permission-btn gateway-permission-btn-deny"
          >
            <XIcon size={14} />
            <span>拒绝</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleAllow}
            disabled={loading}
            className="gateway-permission-btn gateway-permission-btn-allow"
          >
            <CheckIcon size={14} />
            <span>允许</span>
          </Button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
