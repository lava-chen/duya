"use client";

import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/IconButton";
import { PlusIcon, SpinnerGapIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

export interface ExtensionCardProps {
  /** Prebuilt icon node (brand glyph or tinted monogram block). */
  cardIcon?: React.ReactNode;
  /** Legacy bare icon node rendered inside the neutral icon box. */
  icon?: React.ReactNode;
  monogram?: string;
  title: string;
  subtitle?: React.ReactNode;
  description?: string;
  onClick?: () => void;
  onAdd?: () => void;
  addLabel?: string;
  added?: boolean;
  /** Action in flight — the "+" becomes a spinner and is disabled. */
  busy?: boolean;
  /** Right-hand controls (toggles, connect buttons, ...). */
  actions?: React.ReactNode;
  /** Small status dot rendered on the icon corner (e.g. connected). */
  statusDot?: React.ReactNode;
  className?: string;
}

export function ExtensionCard({
  cardIcon,
  icon,
  monogram,
  title,
  subtitle,
  description,
  onClick,
  onAdd,
  addLabel,
  added = false,
  busy = false,
  actions,
  statusDot,
  className,
}: ExtensionCardProps) {
  const { t } = useTranslation();
  const addLabelText = addLabel ?? t("marketplace.add");
  const addedLabelText = t("marketplace.added");
  return (
    <div
      className={cn(
        "group flex items-start gap-3.5 rounded-[14px] border border-border/40 bg-[var(--surface)] p-4 transition-colors",
        (onClick || onAdd) && "hover:border-border/70 hover:bg-[var(--surface-hover)]",
        onClick && "cursor-pointer",
        className
      )}
      onClick={onClick}
    >
      <div className="relative shrink-0">
        {cardIcon ?? (
          <div className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-muted/30 text-accent">
            {icon ?? (monogram ? (
              <span className="text-sm font-semibold">{monogram}</span>
            ) : null)}
          </div>
        )}
        {statusDot}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h4
            className={cn(
              "text-[13px] font-semibold text-foreground truncate",
              onClick && "group-hover:text-accent"
            )}
          >
            {title}
          </h4>
          {actions ? (
            <div className="shrink-0 -mr-1 -mt-0.5" onClick={(e) => e.stopPropagation()}>
              {actions}
            </div>
          ) : onAdd ? (
            <IconButton
              variant="ghost"
              size="sm"
              shape="square"
              aria-label={added ? addedLabelText : addLabelText}
              title={added ? addedLabelText : addLabelText}
              className={cn(
                "shrink-0 -mt-0.5 -mr-1",
                added && "text-emerald-600"
              )}
              disabled={added || busy}
              onClick={(e) => {
                e.stopPropagation();
                if (!added && !busy) onAdd();
              }}
            >
              {busy ? (
                <SpinnerGapIcon size={16} className="animate-spin" />
              ) : added ? (
                "✓"
              ) : (
                <PlusIcon size={18} />
              )}
            </IconButton>
          ) : null}
        </div>
        {subtitle && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {subtitle}
          </div>
        )}
        {description && (
          <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
