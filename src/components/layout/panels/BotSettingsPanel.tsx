"use client";

/**
 * BotSettingsPanel — right-panel page for editing a bot's runtime identity
 * (plan 483 P2.1c). Opened from the bot chat header via
 * `openOrActivatePage("bot-settings", { agentId, title })`.
 *
 * Renders the same form as EditBotDialog through the shared
 * `useBotContactForm` hook. The contact resolves straight from `listBots`
 * (no thread coupling) so streaming activity in the bound session never
 * rebuilds the contact object and re-seeds the form mid-edit.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotContactForm } from "@/hooks/use-bot-contact-form";
import {
  listBots,
  type BotListItem,
} from "@/lib/agent-profile-ipc";
import {
  connectBotChannel,
  disconnectBotChannel,
  listBotChannelRoutes,
  listGatewayPlatformInfo,
  type BotChannelRoute,
  type GatewayPlatformInfo,
} from "@/lib/bot-channels-ipc";
import { BOT_AVATAR_COLORS } from "@/lib/bot-avatar";
import { BotModelField } from "../BotModelField";
import { BotCharacterAvatar } from "../sidebar/BotCharacterAvatar";
import type { BotContact } from "../sidebar/bot-contacts";
import { BotRoutinesSection } from "./BotRoutinesSection";
import type { PageTab } from "./registry";

/** Narrow adapter: the panel only ever receives its own params shape. */
function agentIdFromParams(params: Record<string, unknown> | undefined): string | null {
  const value = params?.agentId;
  return typeof value === "string" && value.trim() ? value : null;
}

/** BotListItem → the BotContact slice the edit form needs. */
function toContact(item: BotListItem): BotContact {
  return {
    agentId: item.id,
    name: item.name,
    title: item.title ?? "",
    description: item.description ?? "",
    model: item.model,
    avatarColor: item.avatarColor,
    avatarUrl: item.avatarUrl,
    boundThreadId: null,
    lastActivity: 0,
  };
}

function PanelNotice({ text }: { text: string }) {
  return (
    <div className="bot-settings-panel bot-settings-panel--notice">
      <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{text}</p>
    </div>
  );
}

/**
 * Per-bot channel bindings over the gateway channel stack: a binding is a
 * gateway profile route ((platform[, chatId]) → this bot), so inbound IM
 * messages (telegram/weixin/feishu/qq/…) run with the bot's persona. Platform
 * credentials are configured once in the channel settings — binding a bot
 * never touches credentials.
 */
function BotChannelsSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [platforms, setPlatforms] = useState<GatewayPlatformInfo[]>([]);
  const [routes, setRoutes] = useState<BotChannelRoute[]>([]);
  const [binding, setBinding] = useState<string | null>(null);
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    // Platforms and bindings load independently — a binding failure must not
    // hide the whole section (it renders from platforms alone).
    try {
      setPlatforms(await listGatewayPlatformInfo());
    } catch {
      // Dev browser without the Electron preload — leave the section empty.
      return;
    }
    try {
      setRoutes(await listBotChannelRoutes(agentId));
      setError("");
    } catch (err) {
      setRoutes([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleBind = useCallback(
    async (platform: string) => {
      setBusy(true);
      setError("");
      try {
        await connectBotChannel(agentId, { platform, chatId: chatId.trim() || undefined });
        setBinding(null);
        setChatId("");
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentId, chatId, reload]
  );

  const handleUnbind = useCallback(
    async (route: BotChannelRoute) => {
      setBusy(true);
      setError("");
      try {
        await disconnectBotChannel(agentId, route.platform, route.chatId);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentId, reload]
  );

  if (platforms.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
        {t("panel.botSettings.channels")}
      </div>
      <div className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
        {t("panel.botSettings.channels.hint")}
      </div>
      {error && (
        <div className="text-xs mb-2" style={{ color: "var(--error, #ef4444)" }}>
          {t("panel.botSettings.channels.errorPrefix")} {error}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {platforms.map((p) => {
          const bound = routes.filter((r) => r.platform === p.platform);
          const isBinding = binding === p.platform;
          return (
            <div
              key={p.platform}
              className="rounded-lg px-3 py-2"
              style={{ border: "1px solid var(--border)", background: "var(--surface)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm" style={{ color: "var(--text)" }}>
                    {p.platform}
                    <span
                      className="ml-2 text-xs"
                      style={{
                        color:
                          bound.length > 0
                            ? "var(--accent)"
                            : "var(--text-muted)",
                      }}
                    >
                      {!p.hasCredentials
                        ? t("panel.botSettings.channels.platformNotConfigured")
                        : !p.enabled
                          ? t("panel.botSettings.channels.platformDisabled")
                          : bound.length > 0
                            ? t("panel.botSettings.channels.connected")
                            : t("panel.botSettings.channels.notConnected")}
                    </span>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setChatId("");
                    setBinding(isBinding ? null : p.platform);
                  }}
                >
                  {t("panel.botSettings.channels.connect")}
                </Button>
              </div>
              {bound.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {bound.map((r, i) => (
                    <span
                      key={`${r.chatId ?? "*"}-${i}`}
                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                      style={{ border: "1px solid var(--border)", color: "var(--text-muted)" }}
                    >
                      {r.chatId ? `#${r.chatId}` : t("panel.botSettings.channels.allChats")}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUnbind(r)}
                        aria-label={t("panel.botSettings.channels.disconnect")}
                        style={{ color: "var(--text-muted)" }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {isBinding && (
                <div className="mt-2 flex flex-col gap-2">
                  <Input
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    placeholder={t("panel.botSettings.channels.chatPlaceholder")}
                    className="w-full"
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => setBinding(null)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void handleBind(p.platform)}>
                      {t("panel.botSettings.channels.save")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BotSettingsPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const { t } = useTranslation();
  const agentId = agentIdFromParams(tab.params);
  const [item, setItem] = useState<BotListItem | null>(null);
  const [loading, setLoading] = useState(!!agentId);

  const reload = useCallback(async () => {
    if (!agentId) {
      setItem(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const bots = await listBots();
      setItem(bots.find((bot) => bot.id === agentId) ?? null);
    } catch {
      // Dev browser without the Electron preload — show the not-found state.
      setItem(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const contact = useMemo(() => (item ? toContact(item) : null), [item]);

  const handleSaved = useCallback(
    (savedId: string) => {
      // Sidebar + bot chat header listen for this to refresh their copies
      // (same decoupled pattern as the office-panel open event).
      window.dispatchEvent(
        new CustomEvent("duya:bot-identity-updated", { detail: { agentId: savedId } })
      );
      void reload();
    },
    [reload]
  );

  const {
    name,
    setName,
    description,
    setDescription,
    color,
    setColor,
    avatarUrl,
    avatarBusy,
    uploadAvatar,
    removeAvatar,
    model,
    setModel,
    modelGroups,
    modelsLoading,
    submitting,
    error,
    canSubmit,
    extraModelOption,
    nameRef,
    save,
  } = useBotContactForm({ active: !!contact, contact, onSaved: handleSaved });

  if (!agentId) return <PanelNotice text={t("panel.botSettings.missing")} />;
  if (loading && !item) return <PanelNotice text={t("panel.botSettings.loading")} />;
  if (!item || !contact) return <PanelNotice text={t("panel.botSettings.notFound")} />;

  return (
    <div className="bot-settings-panel">
      <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
        {t("bot.create.name")}
      </div>
      <Input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("bot.create.namePlaceholder")}
        className="w-full mb-3"
      />

      <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
        {t("bot.create.description")}
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("bot.create.descriptionPlaceholder")}
        rows={2}
        className="w-full mb-4 rounded-lg px-3 py-2 text-sm resize-none"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--text)",
        }}
      />

      <BotModelField
        value={model}
        groups={modelGroups}
        loading={modelsLoading}
        onChange={setModel}
        extraOption={extraModelOption}
      />

      <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
        {t("bot.create.avatar")}
      </div>
      <div className="flex items-center gap-3 mb-3">
        <BotCharacterAvatar
          name={name || "?"}
          agentId={agentId}
          avatarUrl={avatarUrl}
          avatarColor={color}
          size={34}
        />
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={avatarBusy} onClick={() => void uploadAvatar()}>
            {avatarUrl ? t("bot.avatar.replace") : t("bot.avatar.upload")}
          </Button>
          {avatarUrl && (
            <Button variant="secondary" size="sm" disabled={avatarBusy} onClick={() => void removeAvatar()}>
              {t("bot.avatar.remove")}
            </Button>
          )}
        </div>
      </div>
      {!avatarUrl && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          {BOT_AVATAR_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setColor(c.id)}
              aria-label={c.label}
              title={c.label}
              className="rounded-full transition-transform"
              style={{
                width: 18,
                height: 18,
                backgroundColor: c.value,
                outline: color === c.id ? "2px solid var(--text)" : "none",
                outlineOffset: 1,
              }}
            />
          ))}
        </div>
      )}

      {error && (
        <div className="text-sm mb-3" style={{ color: "var(--error, #ef4444)" }}>
          {error}
        </div>
      )}

      <div className="flex justify-end mb-5">
        <Button onClick={() => void save()} disabled={!canSubmit}>
          {t("bot.edit.save")}
        </Button>
      </div>

      <BotChannelsSection agentId={agentId} />

      <BotRoutinesSection agentId={agentId} />
    </div>
  );
}
