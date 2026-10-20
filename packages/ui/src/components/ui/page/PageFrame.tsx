import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageFrameProps {
  children: ReactNode;
  /**
   * Content max-width. Number = px, string = any CSS length.
   * Defaults to the shared token `--page-max-width` (1200px).
   * Pass `"none"` to opt out of the ceiling (full-bleed surfaces
   * such as the canvas editor).
   */
  maxWidth?: number | string;
  className?: string;
  testId?: string;
}

const DEFAULT_MAX = 1200;

/**
 * Unified scrollable page container for main-window views (canvas,
 * automation, gateway, extensions).
 *
 * Owns the vertical scrollbar and constrains content to a centered
 * max-width column, so every main window shares identical width,
 * horizontal padding and scrollbar behaviour. Pair with `<PageHeader />`,
 * `<PageTabs />` and `<PageCard />` to compose a full page.
 */
export function PageFrame({
  children,
  maxWidth = DEFAULT_MAX,
  className,
  testId,
}: PageFrameProps) {
  const isDefault = maxWidth === DEFAULT_MAX;
  const style: CSSProperties | undefined = isDefault
    ? undefined
    : ({
        "--page-max-width":
          maxWidth === "none"
            ? "none"
            : typeof maxWidth === "number"
              ? `${maxWidth}px`
              : maxWidth,
      } as CSSProperties);

  return (
    <div className={cn("page-frame", className)} data-testid={testId}>
      <div className="page-frame-inner" style={style}>
        {children}
      </div>
    </div>
  );
}
