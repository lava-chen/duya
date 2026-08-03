"use client";

import { Button } from "@/components/ui/Button";
import { XIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { AppConnectionProviderDTO } from "@/lib/app-connection-ipc";

interface ManagedOAuthConnectDialogProps {
  provider: AppConnectionProviderDTO | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** Product-facing consent preflight for Duya-managed OAuth connections. */
export function ManagedOAuthConnectDialog({
  provider,
  busy,
  onClose,
  onConfirm,
}: ManagedOAuthConnectDialogProps) {
  const { t } = useTranslation();

  if (!provider) return null;

  const unavailable = !provider.configured;
  const isGoogleDrive = provider.id === "google";
  const title = isGoogleDrive
    ? t("extensions.connections.googleConnect.title" as never)
    : t("extensions.connections.managedConnect.title" as never, { provider: provider.label });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="managed-oauth-connect-title"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-[var(--surface)] p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="managed-oauth-connect-title" className="text-base font-semibold text-foreground">
              {title}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {unavailable
                ? provider.configurationHint
                : t("extensions.connections.managedConnect.description" as never, { provider: provider.label })}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground"
            aria-label={t("marketplace.close")}
            onClick={onClose}
          >
            <XIcon size={16} />
          </button>
        </div>

        {!unavailable && (
          <div className="mt-5 rounded-lg border border-border/50 bg-[var(--surface-solid)] px-3 py-3 text-xs leading-5 text-muted-foreground">
            <p>{t("extensions.connections.googleConnect.browser" as never)}</p>
            <p className="mt-2">{t("extensions.connections.googleConnect.scope" as never)}</p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("extensions.connections.cancel" as never)}
          </Button>
          {!unavailable && (
            <Button type="button" variant="primary" size="sm" onClick={onConfirm} disabled={busy}>
              {busy
                ? t("extensions.connections.connecting" as never)
                : t("extensions.connections.googleConnect.continue" as never)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
