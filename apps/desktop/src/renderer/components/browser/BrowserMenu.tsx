'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CameraIcon,
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  CookieIcon,
  DownloadSimpleIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  TrashIcon,
  UserIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { IconButton } from '@/components/ui/IconButton';

interface BrowserMenuProps {
  onFindInPage: () => void;
  onPrint: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onScreenshot: () => void;
  onImportCookies: () => void;
  onShowHistory: () => void;
  onClearData: () => void;
  onOpenSettings: () => void;
  /** Current zoom percentage, for the menu's zoom row. */
  zoomPercent: number;
  /** Disable page-bound actions (find/print/screenshot/history) on the new-tab page. */
  pageBoundDisabled?: boolean;
}

interface MenuRow {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  comingSoon?: boolean;
  danger?: boolean;
}

/**
 * Top-left functional menu of the built-in browser toolbar (plan 573
 * Phase 2b), mirroring the agentic-browser reference menu. Rows map to
 * real duya capabilities; not-yet-built ones render disabled with a
 * "coming soon" hint (plan 573 phases 4-5).
 */
export function BrowserMenu({
  onFindInPage,
  onPrint,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onScreenshot,
  onImportCookies,
  onShowHistory,
  onClearData,
  onOpenSettings,
  zoomPercent,
  pageBoundDisabled = false,
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

  function run(fn: () => void) {
    return () => {
      fn();
      setOpen(false);
    };
  }

  const findRow: MenuRow = { key: 'find', icon: <MagnifyingGlassIcon size={14} />, label: t('browserMenu.findInPage'), onClick: run(onFindInPage), disabled: pageBoundDisabled };
  const printRow: MenuRow = { key: 'print', icon: <PrinterIcon size={14} />, label: t('browserMenu.print'), onClick: run(onPrint), disabled: pageBoundDisabled };
  const screenshotRow: MenuRow = { key: 'screenshot', icon: <CameraIcon size={14} />, label: t('browserMenu.screenshot'), onClick: run(onScreenshot), disabled: pageBoundDisabled };
  const importRow: MenuRow = { key: 'import', icon: <CookieIcon size={14} />, label: t('browserMenu.importCookies'), onClick: run(onImportCookies) };
  const passwordsRow: MenuRow = { key: 'passwords', icon: <UserIcon size={14} />, label: t('browserMenu.passwordsAutoFill'), disabled: true, comingSoon: true };
  const downloadsRow: MenuRow = { key: 'downloads', icon: <DownloadSimpleIcon size={14} />, label: t('browserMenu.downloads'), disabled: true, comingSoon: true };
  const historyRow: MenuRow = { key: 'history', icon: <ClockCounterClockwiseIcon size={14} />, label: t('browserMenu.history'), onClick: run(onShowHistory) };
  const clearRow: MenuRow = { key: 'clear', icon: <TrashIcon size={14} />, label: t('browserMenu.clearData'), onClick: run(onClearData), danger: true };
  const settingsRow: MenuRow = { key: 'settings', icon: <GearSixIcon size={14} />, label: t('browserMenu.browserSettings'), onClick: run(onOpenSettings) };

  function renderRows(rows: MenuRow[]) {
    return rows.map((row) => (
      <button
        key={row.key}
        type="button"
        className={`browser-menu-item${row.danger ? ' danger' : ''}`}
        role="menuitem"
        disabled={row.disabled}
        onClick={row.onClick}
      >
        {row.icon}
        <span>{row.label}</span>
        {row.comingSoon && <span className="browser-menu-coming-soon">{t('browserMenu.comingSoon')}</span>}
      </button>
    ));
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
          <div className="browser-menu-group">{renderRows([findRow, printRow])}</div>
          <div className="browser-menu-group">
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
          </div>
          <div className="browser-menu-group">{renderRows([screenshotRow])}</div>
          <div className="browser-menu-group">{renderRows([importRow, passwordsRow])}</div>
          <div className="browser-menu-group">{renderRows([downloadsRow, historyRow, clearRow])}</div>
          <div className="browser-menu-group">{renderRows([settingsRow])}</div>
        </div>
      )}
    </div>
  );
}
