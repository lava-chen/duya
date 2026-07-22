"use client";

import React, { useState } from "react";
import type { CanvasElement } from "../..//types/conductor";
import { useStyleUpdate } from "../StylePanel";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import {
  CapsuleToolbar,
  CAPSULE_BTN_BASE,
  CAPSULE_BTN_ACTIVE,
  CAPSULE_DIVIDER,
} from "../toolbar/CapsuleToolbar";
import {
  ElementUtilityActions,
  type ElementUtilityActionsProps,
} from "../toolbar/ElementUtilityActions";

type FontFamily = "sans" | "serif" | "mono";
type TextAlign = "left" | "center" | "right";

const FONT_OPTIONS: { value: FontFamily; labelKey: TranslationKey }[] = [
  { value: "sans", labelKey: "conductor.text.sans" },
  { value: "serif", labelKey: "conductor.text.serif" },
  { value: "mono", labelKey: "conductor.text.mono" },
];

const ALIGN_OPTIONS: { value: TextAlign; label: string; titleKey: TranslationKey }[] = [
  { value: "left", label: "L", titleKey: "conductor.text.alignLeft" },
  { value: "center", label: "C", titleKey: "conductor.text.alignCenter" },
  { value: "right", label: "R", titleKey: "conductor.text.alignRight" },
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
export const TextSelectionToolbar: React.FC<{
  element: CanvasElement;
  utilityActions: ElementUtilityActionsProps;
}> = ({ element, utilityActions }) => {
  const { t } = useTranslation();
  const apply = useStyleUpdate(element);

  const fontFamily = (element.config.fontFamily as FontFamily) || "sans";
  const fontSize = (element.config.fontSize as number) || 16;
  const color = (element.config.color as string) || "var(--text)";
  const align = (element.config.align as TextAlign) || "left";
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
    <CapsuleToolbar positioned={false} zoomAware={false}>
      {FONT_OPTIONS.map((f) => (
        <button
          key={f.value}
          type="button"
          title={t(f.labelKey)}
          onClick={() => apply({ fontFamily: f.value })}
          style={chipStyle(fontFamily === f.value)}
          onMouseEnter={(e) => {
            if (fontFamily !== f.value) e.currentTarget.style.background = "var(--surface-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              fontFamily === f.value ? (CAPSULE_BTN_ACTIVE.background as string) : "transparent";
          }}
        >
          {t(f.labelKey)}
        </button>
      ))}

      <div style={CAPSULE_DIVIDER} />

      <button
        type="button"
        title={t("conductor.text.decreaseFontSize")}
        onClick={() => apply({ fontSize: Math.max(10, fontSize - 2) })}
        style={CAPSULE_BTN_BASE}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        −
      </button>
      <span
        style={{
          minWidth: 20,
          textAlign: "center",
          fontSize: 11,
          color: "var(--text-primary)",
          userSelect: "none",
        }}
      >
        {fontSize}
      </span>
      <button
        type="button"
        title={t("conductor.text.increaseFontSize")}
        onClick={() => apply({ fontSize: Math.min(120, fontSize + 2) })}
        style={CAPSULE_BTN_BASE}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        +
      </button>

      <div style={CAPSULE_DIVIDER} />

      {ALIGN_OPTIONS.map((a) => (
        <button
          key={a.value}
          type="button"
          title={t(a.titleKey)}
          onClick={() => apply({ align: a.value })}
          style={chipStyle(align === a.value)}
          onMouseEnter={(e) => {
            if (align !== a.value) e.currentTarget.style.background = "var(--surface-hover)";
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

      <div style={{ position: "relative" }}>
        <button
          type="button"
          title={t("conductor.text.textColor")}
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
              border: "1px solid var(--command-menu-border)",
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
          title={t("conductor.text.highlightColor")}
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
              border: "1px solid var(--command-menu-border)",
              display: "inline-block",
              backgroundImage: !highlightColor
                ? "linear-gradient(45deg, transparent 45%, var(--text-tertiary) 45%, var(--text-tertiary) 55%, transparent 55%)"
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
      <ElementUtilityActions {...utilityActions} />
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
        background: "var(--command-menu-bg)",
        border: "1px solid var(--command-menu-border)",
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
              border: active ? "2px solid var(--text-primary)" : "1px solid var(--command-menu-border)",
              padding: 0,
              background: sw.hex,
              cursor: "pointer",
              backgroundImage:
                sw.hex === "transparent"
                  ? "linear-gradient(45deg, transparent 45%, var(--text-tertiary) 45%, var(--text-tertiary) 55%, transparent 55%)"
                  : undefined,
              boxShadow: active ? "0 0 0 1px var(--conductor-accent)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
