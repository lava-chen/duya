"use client";

import React from "react";
import type { CanvasElement } from "../..//types/conductor";

const GRID_PX = 80;

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ImageElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const url = (element.config.url as string) || "";
  const fileName = (element.config.fileName as string) || "";
  const alt = (element.config.alt as string) || fileName || "image";
  const objectFit = (element.config.objectFit as "fill" | "contain" | "cover" | "none") || "cover";
  const size = element.config.size as number | undefined;

  const pxW = Math.round(element.position.w * GRID_PX);
  const pxH = Math.round(element.position.h * GRID_PX);

  return (
    <div
      style={{
        width: `${pxW}px`,
        height: `${pxH}px`,
        borderRadius: "var(--radius-element)",
        overflow: "hidden",
        background: "var(--canvas-surface, rgba(0,0,0,0.04))",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        boxShadow: "none",
      }}
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit,
            display: "block",
            userSelect: "none",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--muted)",
            fontSize: 12,
            padding: 8,
            textAlign: "center",
          }}
        >
          Image not available
        </div>
      )}

      {fileName && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "4px 8px",
            fontSize: 11,
            color: "#fff",
            background: "linear-gradient(transparent, rgba(0,0,0,0.6))",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {fileName}
          {size ? ` · ${formatBytes(size)}` : ""}
        </div>
      )}
    </div>
  );
};
