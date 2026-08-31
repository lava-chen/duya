import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/IconButton";
import { XIcon } from "@/components/icons";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Extra header controls rendered before the close button. */
  headerActions?: ReactNode;
  /** Scrollable body region. */
  children: ReactNode;
  /** Sticky footer (action buttons). */
  footer?: ReactNode;
  /** Panel max-width in px (default 640). */
  maxWidth?: number;
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
  headerActions,
  children,
  footer,
  maxWidth = 640,
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

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className={cn("modal-panel", className)}
        style={{ maxWidth }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          {title != null && <h3 className="modal-title">{title}</h3>}
          <div className="flex items-center gap-1">
            {headerActions}
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Close"
              onClick={onClose}
            >
              <XIcon size={18} />
            </IconButton>
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer != null && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
