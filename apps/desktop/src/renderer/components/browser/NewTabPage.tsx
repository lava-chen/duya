'use client';

import { useMemo, useState } from 'react';
import { GlobeIcon, XIcon, ClockCounterClockwiseIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import {
  clearHistory,
  listFavorites,
  listHistory,
  removeFavorite,
  type BrowserVisit,
} from '@/lib/browser-newtab';

interface NewTabPageProps {
  onNavigate: (url: string) => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function Favicon({ visit }: { visit: BrowserVisit }) {
  if (visit.favicon) {
    return <img className="browser-newtab-favicon" src={visit.favicon} alt="" />;
  }
  return <GlobeIcon size={20} />;
}

/**
 * Default landing page for a fresh built-in-browser tab (plan 573 Phase
 * 2b): a favorites bar plus recent-history cards, mirroring the
 * agentic-browser reference. Data comes from the renderer-side store;
 * the agent-side webview records into it via BrowserPanel.
 */
export function NewTabPage({ onNavigate }: NewTabPageProps) {
  const { t } = useTranslation();
  const [favorites, setFavorites] = useState<BrowserVisit[]>(() => listFavorites());
  const [history, setHistory] = useState<BrowserVisit[]>(() => listHistory());

  const historyCards = useMemo(
    () => history.filter((visit) => isRecordable(visit)),
    [history],
  );

  function handleClearHistory() {
    if (!window.confirm(t('browserNewtab.clearHistoryConfirm'))) return;
    clearHistory();
    setHistory([]);
  }

  return (
    <div className="browser-newtab">
      {favorites.length > 0 && (
        <div className="browser-newtab-fav-bar">
          {favorites.map((visit) => (
            <div key={visit.url} className="browser-newtab-fav-chip" title={visit.url}>
              <button
                type="button"
                className="browser-newtab-fav-link"
                onClick={() => onNavigate(visit.url)}
              >
                <Favicon visit={visit} />
                <span className="browser-newtab-fav-title">{visit.title || hostOf(visit.url)}</span>
              </button>
              <button
                type="button"
                className="browser-newtab-fav-remove"
                aria-label={t('browserNewtab.removeFavorite')}
                title={t('browserNewtab.removeFavorite')}
                onClick={() => setFavorites(removeFavorite(visit.url))}
              >
                <XIcon size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="browser-newtab-section">
        <div className="browser-newtab-section-head">
          <ClockCounterClockwiseIcon size={14} />
          <span>{t('browserNewtab.history')}</span>
          {historyCards.length > 0 && (
            <button type="button" className="browser-newtab-clear" onClick={handleClearHistory}>
              {t('browserNewtab.clearHistory')}
            </button>
          )}
        </div>
        {historyCards.length === 0 ? (
          <p className="browser-newtab-empty">{t('browserNewtab.emptyHint')}</p>
        ) : (
          <div className="browser-newtab-card-grid">
            {historyCards.map((visit) => (
              <button
                key={visit.url}
                type="button"
                className="browser-newtab-card"
                onClick={() => onNavigate(visit.url)}
                title={visit.url}
              >
                <span className="browser-newtab-card-icon">
                  <Favicon visit={visit} />
                </span>
                <span className="browser-newtab-card-title">{visit.title || hostOf(visit.url)}</span>
                <span className="browser-newtab-card-host">{hostOf(visit.url)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function isRecordable(visit: BrowserVisit): boolean {
  // Defensive: the store already filters on write, but reads may predate it.
  return /^(https?|file):\/\//i.test(visit.url);
}
