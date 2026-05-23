import { useState, useEffect } from 'react';
import { ClockCounterClockwiseIcon } from '@/components/icons';

interface RecapBannerProps {
  recap: string;
  onDismiss: () => void;
}

export function RecapBanner({ recap, onDismiss }: RecapBannerProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, 10000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (!visible) return null;

  return (
    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
      <div
        className="flex items-start gap-2.5 px-4 py-3 rounded-lg"
        style={{
          backgroundColor: 'var(--accent-soft)',
          borderLeft: `3px solid var(--accent)`,
        }}
      >
        <ClockCounterClockwiseIcon
          size={16}
          className="mt-0.5 shrink-0"
          style={{ color: 'var(--accent)' }}
        />
        <div className="flex-1 min-w-0">
          <div
            className="text-sm leading-relaxed"
            style={{ color: 'var(--text)' }}
          >
            {recap}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setVisible(false);
            onDismiss();
          }}
          className="shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer"
          style={{ color: 'var(--muted)' }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 3L11 11M11 3L3 11"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}