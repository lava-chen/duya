"use client";

import React, { useEffect } from "react";
import { XIcon, PlugIcon, ShieldIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";

interface ExtensionConfirmDialogProps {
  isOpen: boolean;
  extName: string;
  extId: string;
  version: string | null;
  onApprove: () => void;
  onDeny: () => void;
}

export function ExtensionConfirmDialog({
  isOpen,
  extName,
  extId,
  version,
  onApprove,
  onDeny,
}: ExtensionConfirmDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDeny();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onDeny]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
      onClick={onDeny}
    >
      <div
        className="w-full max-w-md rounded-xl p-6 shadow-xl"
        style={{
          backgroundColor: "var(--sidebar-bg)",
          border: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg"
              style={{ backgroundColor: "var(--accent-light, rgba(59, 130, 246, 0.1))" }}
            >
              <ShieldIcon size={18} style={{ color: "var(--accent)" }} />
            </div>
            <h3 className="text-lg font-medium" style={{ color: "var(--text)" }}>
              Extension Connection
            </h3>
          </div>
          <IconButton
            onClick={onDeny}
            variant="default"
            size="sm"
            aria-label="Close"
          >
            <XIcon size={18} />
          </IconButton>
        </div>

        {/* Content */}
        <div className="mb-6">
          <div
            className="flex items-center gap-3 p-3 rounded-lg mb-3"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <PlugIcon size={20} style={{ color: "var(--accent)" }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
                {extName}
              </p>
              {version && (
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  v{version}
                </p>
              )}
            </div>
          </div>

          <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>
            A browser extension is requesting to connect to DUYA. If you trust this extension, click <strong style={{ color: "var(--text)" }}>Allow</strong> to grant access. The extension ID will be saved and trusted automatically for future connections.
          </p>

          <p
            className="text-xs mt-2 px-2 py-1 rounded-md font-mono break-all"
            style={{
              backgroundColor: "var(--surface)",
              color: "var(--muted)",
            }}
          >
            ID: {extId}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="md"
            className="flex-1"
            onClick={onDeny}
          >
            Deny
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            onClick={onApprove}
          >
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}