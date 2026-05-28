"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsCard, SettingsSection } from "@/components/settings/ui";
import { useTranslation } from "@/hooks/useTranslation";
import { getMarketplaceAPI, type MarketplaceEntry } from "@/lib/marketplace-ipc";

export function MarketplaceManagementCard() {
  const { t } = useTranslation();
  const [marketplaces, setMarketplaces] = useState<MarketplaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addKey, setAddKey] = useState("");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [addTrusted, setAddTrusted] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const marketplaceApi = useMemo(() => getMarketplaceAPI(), []);

  const reload = useCallback(async () => {
    if (!marketplaceApi) return;
    setLoading(true);
    setError(null);
    try {
      const res = await marketplaceApi.list();
      if (res.success) {
        setMarketplaces(res.data);
      } else {
        setError(res.error ?? "Failed to load marketplaces");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [marketplaceApi]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAdd = useCallback(async () => {
    if (!marketplaceApi) return;
    if (!addKey.trim() || !addName.trim() || !addUrl.trim()) return;

    const checkRes = await marketplaceApi.checkName(addKey.trim());
    if (checkRes.success && checkRes.data?.blocked) {
      setNameError(`Name "${addKey.trim()}" is blocked (impersonation detected)`);
      return;
    }

    setNameError(null);
    const res = await marketplaceApi.add({
      key: addKey.trim(),
      entry: {
        name: addName.trim(),
        url: addUrl.trim(),
        description: addDesc.trim() || undefined,
        autoUpdate: true,
        trusted: addTrusted,
      },
    });

    if (res.success) {
      setAddKey("");
      setAddName("");
      setAddUrl("");
      setAddDesc("");
      setAddTrusted(false);
      setShowAddForm(false);
      await reload();
    } else {
      setNameError(res.error ?? "Failed to add marketplace");
    }
  }, [marketplaceApi, addKey, addName, addUrl, addDesc, addTrusted, reload]);

  const handleRemove = useCallback(async (key: string) => {
    if (!marketplaceApi) return;
    const res = await marketplaceApi.remove({ key });
    if (res.success) {
      await reload();
    } else {
      setError(res.error ?? "Failed to remove marketplace");
    }
  }, [marketplaceApi, reload]);

  const handleToggleAutoUpdate = useCallback(async (key: string, enabled: boolean) => {
    if (!marketplaceApi) return;
    const res = await marketplaceApi.update({ key, entry: { autoUpdate: enabled } });
    if (res.success) {
      await reload();
    } else {
      setError(res.error ?? "Failed to update marketplace");
    }
  }, [marketplaceApi, reload]);

  const handleReset = useCallback(async () => {
    if (!marketplaceApi) return;
    const res = await marketplaceApi.reset();
    if (res.success) {
      setMarketplaces(res.data);
    } else {
      setError(res.error ?? "Failed to reset marketplaces");
    }
  }, [marketplaceApi]);

  if (!marketplaceApi) {
    return (
      <SettingsSection
        title={t("settings.capabilities.marketplace.title" as never)}
        description={t("settings.capabilities.marketplace.description" as never)}
      >
        <SettingsCard>
          <div className="py-8 text-sm text-muted-foreground text-center">
            Marketplace API not available
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t("settings.capabilities.marketplace.title" as never)}
      description={t("settings.capabilities.marketplace.description" as never)}
    >
      <div className="space-y-4">
        {loading ? (
          <SettingsCard>
            <div className="py-8 text-sm text-muted-foreground text-center">
              {t("settings.capabilities.loading" as never)}
            </div>
          </SettingsCard>
        ) : error ? (
          <SettingsCard variant="danger">
            <div className="py-3 px-4 text-sm text-red-400">{error}</div>
          </SettingsCard>
        ) : (
          <>
            <SettingsCard>
              <div className="p-4 space-y-3">
                {marketplaces.length === 0 ? (
                  <div className="py-6 text-sm text-muted-foreground text-center">
                    No known marketplaces configured.
                  </div>
                ) : (
                  marketplaces.map((mp) => (
                    <div
                      key={mp.key}
                      className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-medium text-foreground truncate">
                            {mp.name}
                          </h4>
                          {mp.trusted && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 shrink-0">
                              Trusted
                            </span>
                          )}
                          <span className="text-[11px] text-muted-foreground truncate">
                            {mp.key}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {mp.url}
                        </div>
                        {mp.description && (
                          <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                            {mp.description}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground">
                            Auto-update
                          </span>
                          <input
                            type="checkbox"
                            checked={mp.autoUpdate}
                            onChange={(e) => handleToggleAutoUpdate(mp.key, e.target.checked)}
                            className="rounded border-border/50"
                          />
                        </div>
                        <button
                          type="button"
                          className="px-2 py-1 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-red-400 hover:border-red-400/30 transition-colors"
                          onClick={() => handleRemove(mp.key)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </SettingsCard>

            <div className="flex items-center gap-2">
              {!showAddForm ? (
                <button
                  type="button"
                  className="px-3 py-1.5 text-xs rounded-md bg-accent text-black hover:opacity-90 transition-opacity"
                  onClick={() => setShowAddForm(true)}
                >
                  Add Marketplace
                </button>
              ) : (
                <button
                  type="button"
                  className="px-3 py-1.5 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setShowAddForm(false);
                    setNameError(null);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded-md border border-border/60 text-muted-foreground hover:text-foreground"
                onClick={handleReset}
              >
                Reset to Defaults
              </button>
            </div>

            {showAddForm && (
              <SettingsCard variant="highlight">
                <div className="p-4 space-y-3">
                  <h4 className="text-sm font-medium text-foreground">
                    Add Known Marketplace
                  </h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">
                        Key (unique ID)
                      </label>
                      <input
                        type="text"
                        value={addKey}
                        onChange={(e) => {
                          setAddKey(e.target.value);
                          setNameError(null);
                        }}
                        placeholder="e.g. my-company"
                        className="w-full px-3 py-1.5 text-sm rounded-md bg-background border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">
                        Display Name
                      </label>
                      <input
                        type="text"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        placeholder="e.g. My Company Plugins"
                        className="w-full px-3 py-1.5 text-sm rounded-md bg-background border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[11px] text-muted-foreground mb-1">
                        URL
                      </label>
                      <input
                        type="url"
                        value={addUrl}
                        onChange={(e) => setAddUrl(e.target.value)}
                        placeholder="https://example.com/marketplace.json"
                        className="w-full px-3 py-1.5 text-sm rounded-md bg-background border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-[11px] text-muted-foreground mb-1">
                        Description
                      </label>
                      <input
                        type="text"
                        value={addDesc}
                        onChange={(e) => setAddDesc(e.target.value)}
                        placeholder="Optional description"
                        className="w-full px-3 py-1.5 text-sm rounded-md bg-background border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="marketplace-add-trusted"
                        checked={addTrusted}
                        onChange={(e) => setAddTrusted(e.target.checked)}
                        className="rounded border-border/50"
                      />
                      <label
                        htmlFor="marketplace-add-trusted"
                        className="text-[11px] text-muted-foreground"
                      >
                        Trusted
                      </label>
                    </div>
                  </div>
                  {nameError && (
                    <div className="text-xs text-red-400">{nameError}</div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs rounded-md bg-accent text-black hover:opacity-90 transition-opacity disabled:opacity-50"
                      disabled={!addKey.trim() || !addName.trim() || !addUrl.trim()}
                      onClick={handleAdd}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </SettingsCard>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}