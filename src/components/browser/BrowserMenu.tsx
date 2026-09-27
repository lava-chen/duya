'use client';

import { useEffect, useRef, useState } from 'react';
import { MagnifyingGlassIcon, MinusIcon, PlusIcon, TrashIcon, CaretDownIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { IconButton } from '@/components/ui/IconButton';

interface BrowserMenuProps {
  onFindInPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onClearData: () => void;
  /** Current zoom percentage, for the menu's zoom row. */
  zoomPercent: number;
}

/**
 * Top-left functional menu of the built-in browser toolbar (plan 573
 * Phase 2b), mirroring the agentic-browser reference: find-in-page, a
 * zoom row and data controls. Only actions backed by real duya
 * capabilities are listed.
 */
export function BrowserMenu({
  onFindInPage,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onClearData,
  zoomPercent,
}: BrowserMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  function closeAfter(fn: () => void) {
    return () => {
      fn();
      setOpen(false);
    };
  }

  return (
    <div className="browser-menu-root" ref={rootRef}>
      <IconButton
        type="button"
        variant="default"
        shape="square"
        className={`browser-panel-icon-btn${open ? ' active' : ''}`}
        aria-label={t('browserMenu.title')}
        aria-expanded={open}
        title={t('browserMenu.title')}
        onClick={() => setOpen((value) => !value)}
      >
        <CaretDownIcon size={14} />
      </IconButton>
      {open && (
        <div className="browser-menu" role="menu">
          <button type="button" className="browser-menu-item" role="menuitem" onClick={closeAfter(onFindInPage)}>
            <MagnifyingGlassIcon size={14} />
            <span>{t('browserMenu.findInPage')}</span>
          </button>
          <div className="browser-menu-zoom" role="group" aria-label={t('browserMenu.zoom')}>
            <span className="browser-menu-zoom-label">{t('browserMenu.zoom')}</span>
            <div className="browser-menu-zoom-controls">
              <IconButton
                type="button"
                variant="default"
                shape="square"
                className="browser-panel-icon-btn"
                aria-label={t('browserMenu.zoomOut')}
                onClick={onZoomOut}
              >
                <MinusIcon size={12} />
              </IconButton>
              <button
                type="button"
                className="browser-menu-zoom-value"
                onClick={onZoomReset}
                title={t('browserMenu.zoomReset')}
              >
                {zoomPercent}%
              </button>
              <IconButton
                type="button"
                variant="default"
                shape="square"
                className="browser-panel-icon-btn"
                aria-label={t('browserMenu.zoomIn')}
                onClick={onZoomIn}
              >
                <PlusIcon size={12} />
              </IconButton>
            </div>
          </div>
          <button type="button" className="browser-menu-item danger" role="menuitem" onClick={closeAfter(onClearData)}>
            <TrashIcon size={14} />
            <span>{t('browserMenu.clearData')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
