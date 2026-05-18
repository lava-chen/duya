"use client";

import React, { useEffect } from "react";
import { XIcon, PlugIcon, ShieldIcon } from "@/components/icons";

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
          <button
            onClick={onDeny}
            className="p-1 rounded-lg transition-colors"
            style={{ color: "var(--muted)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--surface-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            <XIcon size={18} />
          </button>
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
          <button
            onClick={onDeny}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              color: "var(--muted)",
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--surface-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--surface)")
            }
          >
            Deny
          </button>
          <button
            onClick={onApprove}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
            style={{ backgroundColor: "var(--accent)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.opacity = "0.9")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.opacity = "1")
            }
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}