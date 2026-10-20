"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/page";
import type { AppConnectionProviderDTO } from "@/lib/app-connection-ipc";

interface OAuthClientSetupDialogProps {
  provider: AppConnectionProviderDTO | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (values: { clientId: string; clientSecret?: string }) => void;
}

export function OAuthClientSetupDialog({
  provider,
  busy,
  error,
  onClose,
  onSave,
}: OAuthClientSetupDialogProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    if (provider) {
      setClientId("");
      setClientSecret("");
    }
  }, [provider]);

  if (!provider) return null;

  const needsSecret = provider.requiresClientSecret;

  return (
    <Modal
      open={!!provider}
      onClose={onClose}
      title={`Configure ${provider.label}`}
      description="Add the OAuth client created for this app. Credentials are encrypted in the local system vault and never sent to the agent."
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() =>
              onSave({
                clientId,
                ...(clientSecret ? { clientSecret } : {}),
              })
            }
          >
            {busy ? "Saving…" : "Save and connect"}
          </Button>
        </>
      }
    >
      {provider.configurationHint && !provider.configured && (
        <p className="mb-3 text-xs leading-5 text-amber-500">
          {provider.configurationHint}
        </p>
      )}
      <label className="block text-xs font-medium text-foreground" htmlFor="oauth-client-id">
        OAuth client ID
      </label>
      <Input
        id="oauth-client-id"
        className="mt-1"
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
        autoComplete="off"
        required
      />

      {needsSecret && (
        <>
          <label
            className="mt-4 block text-xs font-medium text-foreground"
            htmlFor="oauth-client-secret"
          >
            OAuth client secret
          </label>
          <Input
            id="oauth-client-secret"
            className="mt-1"
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            autoComplete="new-password"
            required
          />
        </>
      )}

      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </Modal>
  );
}