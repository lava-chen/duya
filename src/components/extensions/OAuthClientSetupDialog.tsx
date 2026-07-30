"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { XIcon } from "@/components/icons";
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

  const needsSecret = provider.id === "slack";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="oauth-client-setup-title"
    >
      <form
        className="w-full max-w-md rounded-xl border border-border bg-[var(--surface)] p-5 shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
          });
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="oauth-client-setup-title" className="text-base font-semibold text-foreground">
              Configure {provider.label}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Add the OAuth client created for this app. Credentials are encrypted in the local
              system vault and never sent to the agent.
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground"
            aria-label="Close"
            onClick={onClose}
          >
            <XIcon size={16} />
          </button>
        </div>

        <label className="mt-5 block text-xs font-medium text-foreground" htmlFor="oauth-client-id">
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
            <label className="mt-4 block text-xs font-medium text-foreground" htmlFor="oauth-client-secret">
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

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>
            {busy ? "Saving…" : "Save and connect"}
          </Button>
        </div>
      </form>
    </div>
  );
}
