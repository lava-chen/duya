import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Unified empty state used across main-window views (no automations,
 * no templates, no connectable channels, …). Consistent spacing,
 * icon tint, title / description typography and action placement.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("page-empty-state", className)}>
      {icon != null && <div className="page-empty-state-icon">{icon}</div>}
      <p className="page-empty-state-title">{title}</p>
      {description != null && <p className="page-empty-state-desc">{description}</p>}
      {action != null && <div className="page-empty-state-action">{action}</div>}
    </div>
  );
}
