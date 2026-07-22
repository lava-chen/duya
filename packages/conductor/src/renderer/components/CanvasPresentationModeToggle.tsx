"use client";

import React from "react";
import { FileText, SelectionAll } from "@phosphor-icons/react";
import { useTranslation } from "@/hooks/useTranslation";

export type CanvasPresentationMode = "finite" | "infinite";

interface CanvasPresentationModeToggleProps {
  value: CanvasPresentationMode;
  onChange: (mode: CanvasPresentationMode) => void;
}

export function CanvasPresentationModeToggle({
  value,
  onChange,
}: CanvasPresentationModeToggleProps) {
  const { t } = useTranslation();

  return (
    <div className="canvas-presentation-toggle" role="group" aria-label={t("conductor.presentation.label")}>
      <button
        type="button"
        className={value === "finite" ? "active" : ""}
        aria-pressed={value === "finite"}
        title={t("conductor.presentation.widgetsHint")}
        onClick={() => onChange("finite")}
      >
        <FileText size={14} weight="regular" />
        <span>{t("conductor.presentation.widgets")}</span>
      </button>
      <button
        type="button"
        className={value === "infinite" ? "active" : ""}
        aria-pressed={value === "infinite"}
        title={t("conductor.presentation.canvasHint")}
        onClick={() => onChange("infinite")}
      >
        <SelectionAll size={14} weight="regular" />
        <span>{t("conductor.presentation.canvas")}</span>
      </button>
    </div>
  );
}
