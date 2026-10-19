import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/IconButton";
import { XIcon } from "@/components/icons";

export type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "modal-size-sm",
  md: "modal-size-md",
  lg: "modal-size-lg",
  xl: "modal-size-xl",
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Optional leading icon shown before the title (e.g. provider preset icon). */
  icon?: ReactNode;
  /** Optional muted subtitle shown beneath the title. */
  subtitle?: ReactNode;
  /** Optional helper paragraph rendered at the top of the body. */
  description?: ReactNode;
  /** Extra header controls rendered before the close button. */
  headerActions?: ReactNode;
  /** Scrollable body region. */
  children: ReactNode;
  /** Sticky footer (action buttons). */
  footer?: ReactNode;
  /** Panel max-width in px. Takes precedence over `size` when both are set. */
  maxWidth?: number;
  /** Predefined size: sm 448, md 640 (default), lg 896, xl 1024. */
  size?: ModalSize;
  /** Hide the close button in the header. */
  hideCloseButton?: boolean;
  /** When false, clicking the overlay does not close the dialog. */
  closeOnOverlayClick?: boolean;
  className?: string;
}

/**
 * Unified dialog shell for main-window views. Every modal in the app
 * shares the same overlay, panel, header (title + close), scrollable
 * body and sticky footer — closing on overlay click and Escape.
 */
export function Modal({
  open,
  onClose,
  title,
  icon,
  subtitle,
  description,
  headerActions,
  children,
  footer,
  maxWidth,
  size = "md",
  hideCloseButton = false,
  closeOnOverlayClick = true,
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const showHeader = title != null || icon != null || subtitle != null || headerActions != null || !hideCloseButton;
  const showTitleBlock = title != null || icon != null || subtitle != null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={closeOnOverlayClick ? onClose : undefined}
    >
      <div
        className={cn("modal-panel", SIZE_CLASS[size], className)}
        style={maxWidth != null ? { maxWidth } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {showHeader && (
          <div className="modal-header">
            {showTitleBlock ? (
              <div className="modal-title-row">
                {icon != null && <span className="modal-icon">{icon}</span>}
                <div className="modal-title-block">
                  {title != null && <h3 className="modal-title">{title}</h3>}
                  {subtitle != null && (
                    <span className="modal-subtitle">{subtitle}</span>
                  )}
                </div>
              </div>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-1">
              {headerActions}
              {!hideCloseButton && (
                <IconButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Close"
                  onClick={onClose}
                >
                  <XIcon size={18} />
                </IconButton>
              )}
            </div>
          </div>
        )}
        <div className="modal-body">
          {description != null && (
            <p className="modal-description">{description}</p>
          )}
          {children}
        </div>
        {footer != null && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
