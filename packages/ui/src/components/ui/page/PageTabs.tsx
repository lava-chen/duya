import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageTabDef<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Optional numeric badge rendered next to the label. */
  count?: number;
  disabled?: boolean;
}

export interface PageTabsProps<T extends string = string> {
  tabs: readonly PageTabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  /**
   * underline — top-level section switcher (border-bottom indicator),
   * used by Automation. pill — segmented control, used by Extensions.
   */
  variant?: "underline" | "pill";
  className?: string;
  testId?: string;
}

/**
 * Unified tab bar for main-window views. Two visual variants share the
 * same API and the same font scale, so pages stay consistent whether
 * they use an underline switcher or a segmented pill control.
 */
export function PageTabs<T extends string>({
  tabs,
  active,
  onChange,
  variant = "underline",
  className,
  testId,
}: PageTabsProps<T>) {
  return (
    <div
      role="tablist"
      data-testid={testId}
      className={cn(variant === "pill" ? "page-tabs-pill" : "page-tabs", className)}
    >
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={cn(variant === "pill" ? "page-tab-pill" : "page-tab", selected && "active")}
          >
            {tab.label}
            {tab.count != null && (
              <span className={cn("page-tab-count", selected && "active")}>{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
