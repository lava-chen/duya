"use client";

import React from "react";
import type { CanvasElement } from "../..//types/conductor";

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i + 1).toUpperCase() : "FILE";
}

function isPdf(mimeType: string | undefined, fileName: string): boolean {
  if (mimeType === "application/pdf") return true;
  return fileName.toLowerCase().endsWith(".pdf");
}

function iconFor(ext: string, mimeType?: string): { label: string; color: string } {
  if (mimeType?.startsWith("image/")) return { label: "IMG", color: "#0D7FE0" };
  if (ext === "PDF") return { label: "PDF", color: "#E0431B" };
  if (ext === "DOC" || ext === "DOCX") return { label: "DOC", color: "#2B579A" };
  if (ext === "TXT" || ext === "MD") return { label: "TXT", color: "#5A5A5A" };
  if (ext === "XLS" || ext === "XLSX") return { label: "XLS", color: "#107C41" };
  if (ext === "ZIP") return { label: "ZIP", color: "#C08A00" };
  return { label: ext || "FILE", color: "#666" };
}

export const FileElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const url = (element.config.url as string) || "";
  const fileName = (element.config.fileName as string) || "Untitled";
  const mimeType = (element.config.mimeType as string) || undefined;
  const size = element.config.size as number | undefined;

  const ext = extOf(fileName);
  const isPdfFile = isPdf(mimeType, fileName);
  const { label, color } = iconFor(ext, mimeType);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (url) {
      window.open(url, "_blank");
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: "var(--radius-element)",
        background: "var(--bg-canvas, #fff)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
        boxShadow: "none",
      }}
      title={fileName}
    >
      {isPdfFile && url ? (
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <iframe
            src={`${url}#toolbar=0&navpanes=0&scrollbar=1`}
            title={fileName}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#fff",
              pointerEvents: "auto",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              zIndex: 2,
              padding: "3px 8px",
              fontSize: 10,
              fontWeight: 700,
              color: "#fff",
              background: "#E0431B",
              borderRadius: 4,
              letterSpacing: 0.5,
              pointerEvents: "none",
            }}
          >
            PDF
          </div>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              padding: "6px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text)",
              background: "linear-gradient(transparent, rgba(255,255,255,0.95))",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {fileName}
          </div>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            padding: 14,
            cursor: "pointer",
            userSelect: "none",
          }}
          onClick={handleOpen}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 10,
            }}
          >
            <div
              style={{
                width: 52,
                height: 64,
                borderRadius: 6,
                background: color,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.5,
                position: "relative",
                boxShadow: "none",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: 14,
                  height: 14,
                  background: "rgba(255,255,255,0.35)",
                  borderBottomLeftRadius: 6,
                }}
              />
              {label}
            </div>
          </div>

          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--text)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              textAlign: "center",
              lineHeight: 1.3,
            }}
          >
            {fileName}
          </div>

          <div
            style={{
              marginTop: 4,
              fontSize: 10,
              color: "var(--muted)",
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {ext}
            {size ? ` · ${formatBytes(size)}` : ""}
          </div>
        </div>
      )}
    </div>
  );
};
