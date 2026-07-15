"use client";

import React, { useState } from "react";
import type { CanvasElement } from "../..//types/conductor";
import { useStyleUpdate } from "../StylePanel";
import {
  CapsuleToolbar,
  CAPSULE_BTN_BASE,
  CAPSULE_BTN_ACTIVE,
  CAPSULE_DIVIDER,
} from "../toolbar/CapsuleToolbar";

type FontFamily = "sans" | "serif" | "mono";
type TextAlign = "left" | "center" | "right";

const FONT_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
];

const WEIGHT_OPTIONS = [300, 400, 500, 600, 700];
const LINE_OPTIONS = [1.0, 1.2, 1.5, 1.8, 2.0];
const ALIGN_OPTIONS: { value: TextAlign; label: string }[] = [
  { value: "left", label: "L" },
  { value: "center", label: "C" },
  { value: "right", label: "R" },
];

const COLOR_SWATCHES = [
  { key: "var(--text)", hex: "#1f2937" },
  { key: "#EF4444", hex: "#EF4444" },
  { key: "#3B82F6", hex: "#3B82F6" },
  { key: "#10B981", hex: "#10B981" },
  { key: "#F59E0B", hex: "#F59E0B" },
  { key: "#8B5CF6", hex: "#8B5CF6" },
];

const HIGHLIGHT_SWATCHES = [
  { key: "transparent", hex: "transparent" },
  { key: "#FEF3C7", hex: "#FEF3C7" },
  { key: "#DBEAFE", hex: "#DBEAFE" },
  { key: "#D1FAE5", hex: "#D1FAE5" },
  { key: "#FCE7F3", hex: "#FCE7F3" },
  { key: "#E5E7EB", hex: "#E5E7EB" },
];

/**
 * Floating capsule toolbar for native/text elements.
 *
 * Mirrors the visual shell of StickySelectionToolbar (dark capsule above
 * the selected element) but exposes typography controls instead of shape
 * controls. Inline formatting on the current selection is handled by
 * FloatingTextToolbar during edit mode; this toolbar is for the selected
 * element's overall typography.
 */
export const TextSelectionToolbar: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const apply = useStyleUpdate(element);

  const fontFamily = (element.config.fontFamily as FontFamily) || "sans";
  const fontSize = (element.config.fontSize as number) || 16;
  const fontWeight = (element.config.fontWeight as number) || 400;
  const color = (element.config.color as string) || "var(--text)";
  const align = (element.config.align as TextAlign) || "left";
  const lineHeight = (element.config.lineHeight as number) || 1.5;
  const highlightColor = element.config.highlightColor as string | null | undefined;

  const [colorOpen, setColorOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);

  const chipStyle = (active: boolean): React.CSSProperties => ({
    ...CAPSULE_BTN_BASE,
    width: "auto",
    padding: "0 8px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 500,
    ...(active ? CAPSULE_BTN_ACTIVE : {}),
  });

  return (
    <CapsuleToolbar>
      {FONT_OPTIONS.map((f) => (
        <button
          key={f.value}
          type="button"
          title={f.label}
          onClick={() => apply({ fontFamily: f.value })}
          style={chipStyle(fontFamily === f.value)}
          onMouseEnter={(e) => {
            if (fontFamily !== f.value) e.currentTarget.style.background = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              fontFamily === f.value ? (CAPSULE_BTN_ACTIVE.background as string) : "transparent";
          }}
        >
          {f.label}
        </button>
      ))}

      <div style={CAPSULE_DIVIDER} />

      <button
        type="button"
        title="Decrease font size"
        onClick={() => apply({ fontSize: Math.max(10, fontSize - 2) })}
        style={CAPSULE_BTN_BASE}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        −
      </button>
      <span
        style={{
          minWidth: 20,
          textAlign: "center",
          fontSize: 11,
          color: "rgba(255,255,255,0.85)",
          userSelect: "none",
        }}
      >
        {fontSize}
      </span>
      <button
        type="button"
        title="Increase font size"
        onClick={() => apply({ fontSize: Math.min(120, fontSize + 2) })}
        style={CAPSULE_BTN_BASE}
        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.1)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        +
      </button>

      <div style={CAPSULE_DIVIDER} />

      {WEIGHT_OPTIONS.map((w) => (
        <button
          key={w}
          type="button"
          title={`Weight ${w}`}
          onClick={() => apply({ fontWeight: w })}
          style={chipStyle(fontWeight === w)}
          onMouseEnter={(e) => {
            if (fontWeight !== w) e.currentTarget.style.background = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              fontWeight === w ? (CAPSULE_BTN_ACTIVE.background as string) : "transparent";
          }}
        >
          {w}
        </button>
      ))}

      <div style={CAPSULE_DIVIDER} />

      {ALIGN_OPTIONS.map((a) => (
        <button
          key={a.value}
          type="button"
          title={a.value}
          onClick={() => apply({ align: a.value })}
          style={chipStyle(align === a.value)}
          onMouseEnter={(e) => {
            if (align !== a.value) e.currentTarget.style.background = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              align === a.value ? (CAPSULE_BTN_ACTIVE.background as string) : "transparent";
          }}
        >
          {a.label}
        </button>
      ))}

      <div style={CAPSULE_DIVIDER} />

      {LINE_OPTIONS.map((l) => (
        <button
          key={l}
          type="button"
          title={`Line height ${l}`}
          onClick={() => apply({ lineHeight: l })}
          style={chipStyle(Math.abs(lineHeight - l) < 0.01)}
          onMouseEnter={(e) => {
            if (Math.abs(lineHeight - l) >= 0.01)
              e.currentTarget.style.background = "rgba(255,255,255,0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              Math.abs(lineHeight - l) < 0.01
                ? (CAPSULE_BTN_ACTIVE.background as string)
                : "transparent";
          }}
        >
          {l}
        </button>
      ))}

      <div style={CAPSULE_DIVIDER} />

      <div style={{ position: "relative" }}>
        <button
          type="button"
          title="Text color"
          onClick={() => {
            setColorOpen((v) => !v);
            setHighlightOpen(false);
          }}
          style={{
            ...CAPSULE_BTN_BASE,
            width: "auto",
            padding: "0 6px",
            borderRadius: 14,
            gap: 2,
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: color,
              border: "1px solid rgba(255,255,255,0.25)",
              display: "inline-block",
            }}
          />
        </button>
        {colorOpen && (
          <ColorPicker
            swatches={COLOR_SWATCHES}
            current={color}
            onPick={(hex) => {
              apply({ color: hex });
              setColorOpen(false);
            }}
          />
        )}
      </div>

      <div style={{ position: "relative" }}>
        <button
          type="button"
          title="Highlight color"
          onClick={() => {
            setHighlightOpen((v) => !v);
            setColorOpen(false);
          }}
          style={{
            ...CAPSULE_BTN_BASE,
            width: "auto",
            padding: "0 6px",
            borderRadius: 14,
            gap: 2,
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: highlightColor ?? "transparent",
              border: "1px solid rgba(255,255,255,0.25)",
              display: "inline-block",
              backgroundImage: !highlightColor
                ? "linear-gradient(45deg, transparent 45%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.4) 55%, transparent 55%)"
                : undefined,
            }}
          />
        </button>
        {highlightOpen && (
          <ColorPicker
            swatches={HIGHLIGHT_SWATCHES}
            current={highlightColor ?? "transparent"}
            onPick={(hex) => {
              apply({ highlightColor: hex === "transparent" ? null : hex });
              setHighlightOpen(false);
            }}
          />
        )}
      </div>
    </CapsuleToolbar>
  );
};

function ColorPicker({
  swatches,
  current,
  onPick,
}: {
  swatches: { key: string; hex: string }[];
  current: string;
  onPick: (hex: string) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 36,
        left: "50%",
        transform: "translateX(-50%)",
        display: "grid",
        gridTemplateColumns: "repeat(3, 28px)",
        gap: 6,
        padding: 10,
        background: "rgba(40, 44, 52, 0.98)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        zIndex: 40,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {swatches.map((sw) => {
        const active = current === sw.hex;
        return (
          <button
            key={sw.key}
            type="button"
            title={sw.key}
            onClick={() => onPick(sw.hex)}
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              border: active ? "2px solid #fff" : "1px solid rgba(255,255,255,0.2)",
              padding: 0,
              background: sw.hex,
              cursor: "pointer",
              backgroundImage:
                sw.hex === "transparent"
                  ? "linear-gradient(45deg, transparent 45%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.4) 55%, transparent 55%)"
                  : undefined,
              boxShadow: active ? "0 0 0 1px var(--conductor-accent)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
