"use client";

// MarketplaceRowItem — row-style plugin entry for the marketplace page.
//
// Reference (Granola / Canva-style two-column marketplace): each plugin is a
// horizontal row item — icon on the left, name + single-line description in
// the middle, pill "安装" button (or "已安装" status) on the right. The
// container renders two columns on `md+` and a single column on narrow
// viewports.

import { useCallback } from "react";
import { CheckIcon, SpinnerGapIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";

export interface MarketplaceRowItemProps {
  /** Prebuilt icon node (brand glyph or tinted monogram block). */
  icon: React.ReactNode;
  title: string;
  description?: string;
  /** Click anywhere on the row to open plugin detail. */
  onClick?: () => void;
  /** Click the install button on the right to start install flow. */
  onAdd?: () => void;
  addLabel?: string;
  added?: boolean;
  /** Action in flight — the pill becomes a spinner and is disabled. */
  busy?: boolean;
  className?: string;
}

export function MarketplaceRowItem({
  icon,
  title,
  description,
  onClick,
  onAdd,
  addLabel,
  added = false,
  busy = false,
  className,
}: MarketplaceRowItemProps) {
  const { t } = useTranslation();
  const installLabel = addLabel ?? t("marketplace.install");
  const addedLabel = t("marketplace.added");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!onClick) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick]
  );

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        "group flex items-center gap-4 rounded-xl px-3 py-3 transition-colors",
        "hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        onClick && "cursor-pointer",
        className
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <div className="shrink-0">{icon}</div>

      <div className="min-w-0 flex-1">
        <h4
          className={cn(
            "text-[15px] font-semibold text-foreground truncate",
            "transition-colors group-hover:text-accent"
          )}
        >
          {title}
        </h4>
        {description && (
          <p className="mt-0.5 text-[13px] text-muted-foreground truncate">
            {description}
          </p>
        )}
      </div>

      <div
        className="shrink-0"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {added ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3.5 py-1.5 text-[13px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckIcon size={14} />
            {addedLabel}
          </span>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-label={installLabel}
            onClick={() => {
              if (!busy) onAdd?.();
            }}
            className={cn(
              "rounded-full px-4 py-1.5 text-[13px] font-medium",
              "border border-border/60 text-foreground/80",
              "transition-colors hover:border-accent/40 hover:text-accent",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <SpinnerGapIcon size={14} className="animate-spin" />
                <span>{installLabel}</span>
              </span>
            ) : (
              <span>{installLabel}</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
