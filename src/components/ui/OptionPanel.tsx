import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { CheckIcon } from '@/components/icons';
import './OptionPanel.css';

export interface OptionPanelItem {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  searchText?: string;
  disabled?: boolean;
}

interface OptionPanelProps {
  items: OptionPanelItem[];
  selectedId?: string;
  onSelect: (item: OptionPanelItem) => void;
  onClose?: () => void;
  title?: string;
  searchPlaceholder: string;
  emptyMessage: string;
  footer?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  maxListHeight?: number;
}

export type OptionPanelPlacement = 'above' | 'below';

const VIEWPORT_GAP = 12;
const PANEL_CHROME_HEIGHT = 94;
const DEFAULT_LIST_MAX_HEIGHT = 280;

/** Keeps an anchored option panel inside the viewport as layout changes. */
export function useOptionPanelPlacement<T extends HTMLElement>(
  open: boolean,
  anchorRef: RefObject<T | null>,
): { placement: OptionPanelPlacement; maxListHeight: number } {
  const [placement, setPlacement] = useState<OptionPanelPlacement>('below');
  const [maxListHeight, setMaxListHeight] = useState(DEFAULT_LIST_MAX_HEIGHT);

  const updatePlacement = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const topSpace = Math.max(0, rect.top - VIEWPORT_GAP);
    const bottomSpace = Math.max(0, window.innerHeight - rect.bottom - VIEWPORT_GAP);
    const nextPlacement: OptionPanelPlacement = bottomSpace >= topSpace ? 'below' : 'above';
    const availableSpace = nextPlacement === 'below' ? bottomSpace : topSpace;

    setPlacement(nextPlacement);
    setMaxListHeight(Math.max(0, Math.min(DEFAULT_LIST_MAX_HEIGHT, availableSpace - PANEL_CHROME_HEIGHT)));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [open, updatePlacement]);

  return { placement, maxListHeight };
}

/**
 * Compact setting-panel surface for choosing an item from an input-adjacent
 * popover. It keeps filtering and keyboard selection consistent across the
 * composer and welcome flows.
 */
export function OptionPanel({
  items,
  selectedId,
  onSelect,
  onClose,
  title,
  searchPlaceholder,
  emptyMessage,
  footer,
  className,
  style,
  maxListHeight = DEFAULT_LIST_MAX_HEIGHT,
}: OptionPanelProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;

    return items.filter((item) =>
      [item.label, item.description, item.meta, item.searchText]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [items, query]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(-1);
  }, [query]);

  const selectActiveItem = () => {
    const activeItem = filteredItems[activeIndex];
    if (activeItem && !activeItem.disabled) onSelect(activeItem);
  };

  return (
    <div
      className={`option-panel ${className ?? ''}`}
      role="dialog"
      aria-label={title ?? searchPlaceholder}
      style={style}
    >
      <div className="option-panel-search">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, filteredItems.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              selectActiveItem();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose?.();
            }
          }}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        {title && <span className="option-panel-title">{title}</span>}
      </div>

      <div className="option-panel-list" role="listbox" style={{ maxHeight: maxListHeight }}>
        {filteredItems.length === 0 ? (
          <div className="option-panel-empty">{emptyMessage}</div>
        ) : (
          filteredItems.map((item, index) => {
            const isSelected = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={item.disabled}
                className={`option-panel-item ${isSelected ? 'is-selected' : ''} ${
                  index === activeIndex ? 'is-active' : ''
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(item)}
              >
                <span className="option-panel-check" aria-hidden="true">
                  {isSelected && <CheckIcon size={14} />}
                </span>
                <span className="option-panel-copy">
                  <span className="option-panel-label">{item.label}</span>
                  {item.description && <span className="option-panel-description">{item.description}</span>}
                </span>
                {item.meta && <span className="option-panel-meta">{item.meta}</span>}
              </button>
            );
          })
        )}
      </div>

      {footer && <div className="option-panel-footer">{footer}</div>}
    </div>
  );
}
