/**
 * src/components/settings/forms/shared/ModelInputWithFetch.tsx
 *
 * Plan 205 Phase H3: shared "model input with fetch" component.
 * Modeled on cc-switch's `ModelInputWithFetch` (`forms/shared/`),
 * ported to duya's CSS-variable / Tailwind style with a native
 * `<details>` element for the dropdown (no Radix dependency).
 *
 * The component renders one of four visual states:
 *   1. **Empty + `onFetch` provided** — Input + Download icon button.
 *      Clicking the button calls `onFetch`; the parent is
 *      responsible for updating `fetchedModels` and `isLoading`.
 *   2. **Loading** — Input + Spinner (button disabled).
 *   3. **Fetched** — Input + ChevronDown trigger. Clicking
 *      opens a native `<details>` dropdown listing the fetched
 *      models, grouped by `ownedBy` (vendor) with separators.
 *   4. **No `onFetch` and no fetched models** — plain Input
 *      (read-only / manual entry mode).
 *
 * The component never calls IPC directly; the parent owns the
 * mutation. This keeps it pure and easy to test.
 */

import { useEffect, useRef, useState } from 'react';
import {
  DownloadSimpleIcon,
  SpinnerGapIcon,
  CaretDownIcon,
  CheckIcon,
} from '@/components/icons';
import type { FetchedModel } from '@/lib/ipc-client';
import { useTranslation } from '@/hooks/useTranslation';

export interface ModelInputWithFetchProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  fetchedModels: FetchedModel[];
  isLoading: boolean;
  /** Invoked when the user clicks the Download button. The
   *  parent should set `isLoading=true`, perform the fetch,
   *  then update `fetchedModels`. If omitted, the button is
   *  hidden (manual entry mode). */
  onFetch?: () => void;
  /** Inline error message (e.g. 401 / 404 from the IPC). */
  error?: string | null;
}

export function ModelInputWithFetch({
  id,
  value,
  onChange,
  placeholder,
  fetchedModels,
  isLoading,
  onFetch,
  error,
}: ModelInputWithFetchProps) {
  const { t } = useTranslation();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [filter, setFilter] = useState('');

  // Outside-click close. `<details>` doesn't have a native
  // outside-click handler.
  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      if (!el.open) return;
      const target = e.target as Node | null;
      if (target && !el.contains(target)) {
        el.open = false;
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Close the dropdown after a selection.
  const handleSelect = (modelId: string) => {
    onChange(modelId);
    if (detailsRef.current) detailsRef.current.open = false;
  };

  // Group fetched models by vendor. The list is filtered by
  // a free-text query first so the user can narrow down
  // long lists (e.g. OpenRouter's 100+ models).
  const filtered = filter
    ? fetchedModels.filter((m) =>
        m.id.toLowerCase().includes(filter.toLowerCase()),
      )
    : fetchedModels;
  const grouped: Record<string, FetchedModel[]> = {};
  for (const m of filtered) {
    const vendor = m.ownedBy || 'Other';
    if (!grouped[vendor]) grouped[vendor] = [];
    grouped[vendor].push(m);
  }
  const vendors = Object.keys(grouped).sort();
  const hasFetched = fetchedModels.length > 0;

  return (
    <div className="space-y-1.5" data-testid={`model-input-${id}`}>
      <div className="flex gap-1.5">
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="flex-1 px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
        />

        {/* Fetched state: Input + chevron dropdown trigger */}
        {hasFetched && !isLoading && (
          <details
            ref={detailsRef}
            data-testid={`model-input-dropdown-${id}`}
            className="relative"
          >
            <summary
              className="list-none cursor-pointer h-full inline-flex items-center px-2.5 rounded-lg border border-border/50 bg-chip text-muted-foreground hover:text-foreground"
              title={t('provider.modelInput.pickFromList')}
            >
              <CaretDownIcon size={14} />
            </summary>
            <div
              role="listbox"
              className="absolute right-0 top-full mt-1 z-30 w-80 max-h-72 overflow-y-auto rounded-lg border border-border/50 bg-surface shadow-xl p-1"
            >
              {fetchedModels.length > 6 && (
                <div className="p-1 border-b border-border/30 mb-1">
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t('provider.modelInput.filterPlaceholder')}
                    className="w-full px-2 py-1 rounded border border-border/50 text-xs bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>
              )}
              {vendors.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('provider.modelInput.noMatch')}
                </div>
              ) : (
                vendors.map((vendor, vi) => (
                  <div key={vendor}>
                    {vi > 0 && (
                      <div className="my-1 border-t border-border/20" />
                    )}
                    <div className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {vendor}
                    </div>
                    {grouped[vendor].map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={m.id === value}
                        onClick={() => handleSelect(m.id)}
                        data-testid={`model-input-option-${m.id}`}
                        className={
                          'w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs font-mono hover:bg-accent/10 ' +
                          (m.id === value ? 'bg-accent/15 text-accent' : '')
                        }
                      >
                        <span className="shrink-0 w-4 h-4 flex items-center justify-center">
                          {m.id === value && <CheckIcon size={10} />}
                        </span>
                        <span className="truncate">{m.id}</span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </details>
        )}

        {/* Loading state: Input + spinner */}
        {!hasFetched && isLoading && (
          <button
            type="button"
            disabled
            data-testid={`model-input-loading-${id}`}
            className="inline-flex items-center px-2.5 rounded-lg border border-border/50 bg-chip text-muted-foreground"
          >
            <SpinnerGapIcon size={14} className="animate-spin" />
          </button>
        )}

        {/* Empty + onFetch: Input + download button */}
        {!hasFetched && !isLoading && onFetch && (
          <button
            type="button"
            onClick={onFetch}
            data-testid={`model-input-fetch-${id}`}
            className="inline-flex items-center gap-1 px-2.5 rounded-lg border border-border/50 bg-chip text-muted-foreground hover:text-foreground hover:border-accent/50"
            title={t('provider.modelInput.fetch')}
          >
            <DownloadSimpleIcon size={14} />
          </button>
        )}
      </div>

      {error && (
        <p
          data-testid={`model-input-error-${id}`}
          className="text-[11px] text-destructive"
        >
          {error}
        </p>
      )}

      {hasFetched && !isLoading && (
        <p className="text-[10px] text-muted-foreground">
          {t('provider.modelInput.summary', {
            count: fetchedModels.length,
          })}
        </p>
      )}
    </div>
  );
}
