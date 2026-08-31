import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned action cluster (buttons, search field, …). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Unified page title block shared by every main-window view.
 * Font size / weight / colour come from the `--page-*` typography
 * tokens so all pages render the exact same title scale.
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("page-header", className)}>
      <div className="page-header-text">
        <h1 className="page-title">{title}</h1>
        {subtitle != null && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions != null && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
