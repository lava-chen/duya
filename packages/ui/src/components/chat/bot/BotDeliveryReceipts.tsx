import { useEffect, useState } from 'react';
import type { BotDelivery } from '@duya/agent-protocol/bot-delivery-api';
import { useTranslation } from '@/hooks/useTranslation';

/** Read durable receipts; observing this card never starts or retries work. */
export function BotDeliveryReceipts({ botId }: { botId: string | null }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{ botId: string; rows: readonly BotDelivery[]; failed: boolean } | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.botTurn?.listDeliveries;
    if (!botId || !api) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const rows = await api({ botId });
        if (!cancelled) setSnapshot({ botId, rows, failed: false });
      } catch {
        if (!cancelled) setSnapshot({ botId, rows: [], failed: true });
      } finally {
        if (!cancelled) timer = setTimeout(() => { void refresh(); }, 2_000);
      }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [botId]);
  if (!snapshot || snapshot.botId !== botId) return null;
  if (snapshot.failed) return <p role="status" className="text-sm text-[var(--text-secondary)]">{t('bot.delivery.loadFailed')}</p>;
  if (!snapshot.rows.length) return null;
  return (
    <section aria-label={t('bot.delivery.title')} className="my-3 space-y-2">
      {snapshot.rows.slice(-20).map((row) => (
        <details key={row.id} className="rounded-lg border border-[var(--border)] p-3 text-sm">
          <summary className="cursor-pointer text-[var(--text)]">
            {row.target.platform} · {t(`bot.delivery.${row.status}`)}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-[var(--text-secondary)]">{row.outbound.content}</p>
          {row.status === 'unknown' && <p className="mt-2">{t('bot.delivery.unknownHelp')}</p>}
          {row.remoteMessageId && <p className="mt-2 text-[var(--text-secondary)]">{t('bot.delivery.receipt')}: {row.remoteMessageId}</p>}
        </details>
      ))}
    </section>
  );
}
