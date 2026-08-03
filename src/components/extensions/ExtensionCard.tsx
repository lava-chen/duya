"use client";

import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/IconButton";
import { PlusIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

export interface ExtensionCardProps {
  icon?: React.ReactNode;
  monogram?: string;
  title: string;
  subtitle?: React.ReactNode;
  description?: string;
  onClick?: () => void;
  onAdd?: () => void;
  addLabel?: string;
  added?: boolean;
  actions?: React.ReactNode;
  className?: string;
}

export function ExtensionCard({
  icon,
  monogram,
  title,
  subtitle,
  description,
  onClick,
  onAdd,
  addLabel,
  added = false,
  actions,
  className,
}: ExtensionCardProps) {
  const { t } = useTranslation();
  const addLabelText = addLabel ?? t("marketplace.add");
  const addedLabelText = t("marketplace.added");
  const showMonogram = !icon && monogram;
  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-xl border border-border/30 bg-[var(--surface)] p-4 transition-colors",
        (onClick || onAdd) && "hover:border-border/50",
        onClick && "cursor-pointer",
        className
      )}
      onClick={onClick}
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted/30 text-accent">
        {icon ?? (
          <span className="text-base font-semibold">{showMonogram}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4
              className={cn(
                "text-sm font-semibold text-foreground truncate",
                onClick && "group-hover:text-accent"
              )}
            >
              {title}
            </h4>
            {subtitle && (
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                {subtitle}
              </div>
            )}
          </div>
          {actions ? (
            <div className="shrink-0 -mr-1" onClick={(e) => e.stopPropagation()}>
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
              onClick={(e) => {
                e.stopPropagation();
                if (!added) onAdd();
              }}
              disabled={added}
            >
              {added ? "✓" : <PlusIcon size={18} />}
            </IconButton>
          ) : null}
        </div>
        {description && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
