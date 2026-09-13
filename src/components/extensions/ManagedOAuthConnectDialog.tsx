"use client";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/page";
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

  const description = unavailable
    ? provider.configurationHint
    : t("extensions.connections.managedConnect.description" as never, { provider: provider.label });

  return (
    <Modal
      open={!!provider}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
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
        </>
      }
    >
      {!unavailable && (
        <div className="rounded-lg border border-border/50 bg-[var(--surface-solid)] px-3 py-3 text-xs leading-5 text-muted-foreground">
          <p>{t("extensions.connections.googleConnect.browser" as never)}</p>
          <p className="mt-2">{t("extensions.connections.googleConnect.scope" as never)}</p>
        </div>
      )}
    </Modal>
  );
}