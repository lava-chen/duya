"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CaretRightIcon } from "@/components/icons";

export type MenuAction =
  | {
      kind: "action";
      id: string;
      label: string;
      shortcut?: string;
      iconLeft?: ReactNode;
      iconRight?: ReactNode;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /**
       * Optional secondary line rendered below the label in a smaller /
       * muted style. Used by project / thread pickers to show the working
       * directory or last-activity timestamp next to the primary name.
       */
      description?: ReactNode;
      /**
       * Optional className applied to the rendered item element. Used by
       * the sidebar project / bot menus to re-apply legacy item styles
       * (`.project-dropdown-item`, `.bot-dropdown-item`) so the visual is
       * byte-for-byte equivalent to the prior hand-rolled implementation.
       */
      className?: string;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      iconLeft?: ReactNode;
      items: MenuAction[];
      /**
       * Optional className applied to the submenu's inner popover div.
       * Used by the sidebar project / bot menus to re-apply the legacy
       * `.project-dropdown-submenu` look (Plan 471 v4: `top: -4px; left: 100%`,
       * `min-width: 180px`, plus the `.project-dropdown-submenu-flip-left`
       * variant when the parent menu sits in the right gutter).
       */
      className?: string;
    }
  | { kind: "divider"; id: string }
  | { kind: "section"; id: string; title: string; items: MenuAction[] };

interface DropdownMenuProps {
  trigger: ReactNode;
  items: MenuAction[];
  className?: string;
  portalClassName?: string;
  /**
   * Optional content rendered at the top of the menu (e.g. a search input).
   * Drawn above the items and visually separated by a bottom border. The
   * host must handle its own open state and stop click events from
   * propagating so a click on the input does not toggle the trigger.
   */
  header?: ReactNode;
  /** Controlled open state - when provided, menu visibility is controlled externally */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Override position - use exact screen coordinates for menu's top-left corner */
  anchorPosition?: { x: number; y: number };
  /**
   * Which side of the trigger the menu opens on. Defaults to `"below"`.
   * Mirrors the `OptionPanel` "placement" prop so pickers can flip the
   * menu above the trigger when there is no room below.
   */
  side?: "below" | "above";
  /**
   * Horizontal alignment relative to the trigger. Defaults to `"start"`
   * (left edge of the menu meets the right edge of the trigger, matching
   * the historical sidebar ⋯ menu behavior). Use `"center"` for
   * centered popovers (e.g. the project picker in the welcome composer).
   */
  align?: "start" | "center" | "end";
  /**
   * Menu width in pixels. When omitted, the menu keeps its natural
   * content width (suitable for narrow action lists). Use this when the
   * host needs a consistent min-width regardless of content.
   */
  minWidth?: number;
  maxWidth?: number;
  /**
   * Hard cap on the menu's height (px). When omitted, the menu derives
   * a cap from the viewport so the popover never overflows the window
   * and a long item list becomes scrollable instead of pushing past
   * the bottom of the screen. Use this prop to override the cap (e.g.
   * a host that wants a fixed-height picker).
   */
  maxHeight?: number;
}

export function DropdownMenu({
  trigger,
  items,
  className,
  portalClassName,
  header,
  open,
  onOpenChange,
  anchorPosition,
  side = "below",
  align = "start",
  minWidth,
  maxWidth,
  maxHeight,
}: DropdownMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [resolvedMaxHeight, setResolvedMaxHeight] = useState<number | undefined>(
    undefined
  );
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Support both controlled (external) and uncontrolled (internal) open state
  const isControlled = open !== undefined;
  const actualOpen = isControlled ? open : internalOpen;

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(newOpen);
      }
      onOpenChange?.(newOpen);
      if (!newOpen) {
        setOpenSubmenu(null);
      }
    },
    [isControlled, onOpenChange]
  );

  // Position the menu when it opens
  useLayoutEffect(() => {
    if (!actualOpen) return;
    if (anchorPosition !== undefined) {
      setPosition({ top: anchorPosition.y, left: anchorPosition.x });
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const GAP = 4;
    // We can't read `menu.offsetWidth` reliably on the first paint
    // (the portal mounts during the same commit), so anchor the layout
    // math to the explicit `minWidth` / `maxWidth` props. When neither
    // is provided we fall back to the trigger's own width, which is a
    // good enough approximation for narrow action lists.
    const widthHint =
      typeof minWidth === "number" && typeof maxWidth === "number"
        ? Math.min(maxWidth, Math.max(minWidth, rect.width))
        : typeof minWidth === "number"
          ? Math.max(minWidth, rect.width)
          : rect.width;
    const menuWidth = menu?.offsetWidth ?? widthHint;
    const menuHeight = menu?.offsetHeight ?? 0;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Height cap derived from viewport so long lists scroll inside the
    // popover instead of overflowing the bottom of the screen. 360px
    // default ceiling keeps the menu compact (~10 rows) — taller popovers
    // look heavy next to a small composer. Hosts can override via the
    // `maxHeight` prop (e.g. a fixed-height command palette).
    const VIEWPORT_FLOOR = 120;
    const MAX_HEIGHT_CEILING = 360;
    const belowRoom = viewportH - rect.bottom - GAP - 8;
    const aboveRoom = rect.top - GAP - 8;
    const defaultCap =
      side === "above"
        ? Math.max(VIEWPORT_FLOOR, aboveRoom)
        : Math.max(VIEWPORT_FLOOR, belowRoom);
    const nextMaxHeight =
      typeof maxHeight === "number"
        ? Math.min(maxHeight, MAX_HEIGHT_CEILING)
        : Math.min(defaultCap, MAX_HEIGHT_CEILING);

    let top = side === "above" ? rect.top - menuHeight - GAP : rect.bottom + GAP;
    if (top < 0) top = rect.bottom + GAP; // fall back to below
    if (top + menuHeight > viewportH) top = Math.max(0, viewportH - menuHeight - 4);

    let left = rect.left;
    if (align === "center") left = rect.left + rect.width / 2 - menuWidth / 2;
    else if (align === "end") left = rect.right - menuWidth;
    if (left < 4) left = 4;
    if (left + menuWidth > viewportW) left = Math.max(4, viewportW - menuWidth - 4);

    setResolvedMaxHeight(nextMaxHeight);
    setPosition({ top, left });
  }, [actualOpen, anchorPosition, side, align, items, header, minWidth, maxWidth, maxHeight]);

  // Close on click outside
  useEffect(() => {
    if (!actualOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleOpenChange(false);
      }
    };

    // Delay to avoid immediate close on the same click that opened
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [actualOpen, handleOpenChange]);

  // Close on Escape
  useEffect(() => {
    if (!actualOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [actualOpen, handleOpenChange]);

  const handleSubmenuMouseEnter = useCallback((id: string) => {
    if (submenuTimerRef.current) {
      clearTimeout(submenuTimerRef.current);
      submenuTimerRef.current = null;
    }
    setOpenSubmenu(id);
  }, []);

  const handleSubmenuMouseLeave = useCallback(() => {
    submenuTimerRef.current = setTimeout(() => {
      setOpenSubmenu(null);
    }, 150);
  }, []);

  const handleItemClick = useCallback(
    (item: MenuAction) => {
      if (item.kind === "action") {
        if (!item.disabled) {
          item.onSelect();
          handleOpenChange(false);
        }
      }
    },
    [handleOpenChange]
  );

  const renderItem = useCallback(
    (item: MenuAction): ReactNode => {
      if (item.kind === "divider") {
        return (
          <div key={item.id} className="sidebar-project-menu-divider" />
        );
      }

      if (item.kind === "section") {
        return (
          <div key={item.id} className="sidebar-project-menu-section">
            {item.title && (
              <span className="sidebar-project-menu-section-title">
                {item.title}
              </span>
            )}
            {item.items.map((sectionItem) => renderItem(sectionItem))}
          </div>
        );
      }

      if (item.kind === "submenu") {
        return (
          <div
            key={item.id}
            className="sidebar-project-menu-item has-submenu"
            onMouseEnter={() => handleSubmenuMouseEnter(item.id)}
            onMouseLeave={handleSubmenuMouseLeave}
          >
            {item.iconLeft && (
              <span className="sidebar-project-menu-item-icon">{item.iconLeft}</span>
            )}
            <span>{item.label}</span>
            <CaretRightIcon
              size={12}
              style={{ marginLeft: "auto", flexShrink: 0 }}
            />
            {openSubmenu === item.id && (
              <div
                className={item.className ?? "sidebar-project-submenu"}
                onMouseEnter={() => handleSubmenuMouseEnter(item.id)}
                onMouseLeave={handleSubmenuMouseLeave}
              >
                {item.items.map((subItem) => renderItem(subItem))}
              </div>
            )}
          </div>
        );
      }

      return (
        <button
          key={item.id}
          type="button"
          className={`sidebar-project-menu-item${
            item.danger ? " danger" : ""
          }${item.disabled ? " disabled" : ""}${
            item.description ? " has-description" : ""
          }${item.className ? ` ${item.className}` : ""}`}
          onClick={() => handleItemClick(item)}
          disabled={item.disabled}
        >
          {item.iconLeft && (
            <span className="sidebar-project-menu-item-icon">{item.iconLeft}</span>
          )}
          <span className="sidebar-project-menu-item-copy">
            <span className="sidebar-project-menu-item-label">{item.label}</span>
            {item.description && (
              <span className="sidebar-project-menu-item-description">{item.description}</span>
            )}
          </span>
          {item.iconRight && (
            <span style={{ marginLeft: "auto", flexShrink: 0 }}>
              {item.iconRight}
            </span>
          )}
          {item.shortcut && !item.iconRight && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: "0.7rem",
                color: "var(--muted)",
                flexShrink: 0,
              }}
            >
              {item.shortcut}
            </span>
          )}
        </button>
      );
    },
    [openSubmenu, handleSubmenuMouseEnter, handleSubmenuMouseLeave, handleItemClick]
  );

  return (
    <>
      <div
        ref={triggerRef}
        onClick={() => handleOpenChange(!actualOpen)}
        style={{ display: "inline-flex" }}
      >
        {trigger}
      </div>
      {actualOpen &&
        createPortal(
          <div
            ref={menuRef}
            className={`sidebar-project-menu${className ? ` ${className}` : ""}`}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              zIndex: 1000, // Higher than sidebar-project-menu's default 100
              minWidth: minWidth,
              maxWidth: maxWidth,
            }}
            role="menu"
            aria-label="Dropdown menu"
          >
            {header && <div className="sidebar-project-menu-header">{header}</div>}
            <div
              className="sidebar-project-menu-list"
              style={{
                maxHeight: resolvedMaxHeight,
                overflowY: resolvedMaxHeight ? "auto" : undefined,
              }}
            >
              {items.map((item) => renderItem(item))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}