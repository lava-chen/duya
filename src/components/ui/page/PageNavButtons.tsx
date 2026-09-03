import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";

export interface PageNavButtonDef<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Optional numeric badge rendered next to the label. */
  count?: number;
  disabled?: boolean;
}

export interface PageNavButtonsProps<T extends string = string> {
  tabs: readonly PageNavButtonDef<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
  testId?: string;
}

/**
 * Unified sub-interface switcher rendered as a horizontal row of duya
 * `Button` components (ghost variant, 平排排列). The active tab gets the
 * accent text colour plus a soft surface highlight; inactive tabs stay
 * muted. Every main-window view that owns sub-views (automation,
 * extensions, conductor library) shares the same
 * "title → row of buttons → content" layout through this component.
 */
export function PageNavButtons<T extends string>({
  tabs,
  active,
  onChange,
  className,
  testId,
}: PageNavButtonsProps<T>) {
  return (
    <div
      role="tablist"
      data-testid={testId}
      className={cn("flex items-center gap-1.5 flex-wrap", className)}
    >
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <Button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            variant="ghost"
            size="sm"
            onClick={() => onChange(tab.id)}
            className={cn(
              "h-8 px-3 rounded-lg",
              selected
                ? "text-accent bg-[var(--surface-hover)] font-medium"
                : "text-muted-foreground",
            )}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className={cn(
                  "text-xs tabular-nums",
                  selected ? "text-accent/70" : "text-muted-foreground/70",
                )}
              >
                {tab.count}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
