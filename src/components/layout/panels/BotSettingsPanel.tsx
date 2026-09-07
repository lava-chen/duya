"use client";

/**
 * BotSettingsPanel — right-panel page for a bot (plan 483 P2.1c). Opened from
 * the bot chat header via `openOrActivatePage("bot-settings", { agentId, title })`.
 *
 * Two views:
 *   - main (landing): channel bindings + routines only, with a gear button
 *     (top-right) into the identity view.
 *   - identity: name / description / model / avatar with NO save button —
 *     every change is persisted live (600ms debounce; avatar upload/remove
 *     stay immediate main-process actions).
 *
 * The contact resolves straight from `listBots` (no thread coupling) so
 * streaming activity in the bound session never rebuilds the contact object
 * and re-seeds the form mid-edit.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { ArrowLeftIcon, GearSixIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotContactForm } from "@/hooks/use-bot-contact-form";
import {
  listBots,
  updateBotIdentity,
  updateConfigAgent,
  type BotListItem,
} from "@/lib/agent-profile-ipc";
import {
  connectBotChannel,
  disconnectBotChannel,
  listBotChannelManifests,
  listBotChannels,
  beginBotChannelQr,
  pollBotChannelQr,
  cancelBotChannelQr,
  type BotChannelManifest,
} from "@/lib/bot-channels-ipc";
import { BotModelSelectorField } from "../BotModelSelectorField";
import { BotAvatarPicker } from "../BotAvatarPicker";
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
    provider: item.provider,
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
 * Per-bot channel bindings (plan 488, grok-form): each bot owns its platform
 * connection — the token is stored in the per-agent secret store and a live
 * inbound connector wakes this bot's persistent session on every message.
 */
function BotChannelsSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [manifests, setManifests] = useState<BotChannelManifest[]>([]);
  const [boundPlatforms, setBoundPlatforms] = useState<Map<string, string>>(new Map());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [credential, setCredential] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qrSession, setQrSession] = useState<{ sessionId: string; image: string } | null>(null);
  const [qrStatus, setQrStatus] = useState<"waiting" | "scanned" | "bound" | "failed">("waiting");

  /** Platforms whose manifest demands non-token credential fields bind via QR. */
  const isQrPlatform = (m: BotChannelManifest): boolean =>
    m.availability === "available" &&
    !!m.credentialFields &&
    m.credentialFields.some((f) => f.field !== "token");

  const reload = useCallback(async () => {
    // Manifests and bindings load independently — a binding failure must not
    // hide the whole section (it renders from manifests alone).
    try {
      setManifests(await listBotChannelManifests());
    } catch {
      // Dev browser without the Electron preload — leave the section empty.
      return;
    }
    try {
      const channels = await listBotChannels(agentId);
      setBoundPlatforms(new Map(channels.map((c) => [c.platform, c.label])));
      setError("");
    } catch (err) {
      setBoundPlatforms(new Map());
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleQrBegin = useCallback(
    async (platform: string) => {
      setBusy(true);
      setError("");
      try {
        const s = await beginBotChannelQr(agentId, platform, label.trim() || undefined);
        setConnecting(platform);
        setQrSession({ sessionId: s.sessionId, image: s.qrImage });
        setQrStatus("waiting");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentId, label],
  );

  const handleQrCancel = useCallback(async () => {
    if (qrSession) {
      try {
        await cancelBotChannelQr(qrSession.sessionId);
      } catch {
        // best-effort
      }
    }
    setConnecting(null);
    setQrSession(null);
    setQrStatus("waiting");
  }, [qrSession]);

  // Poll the QR session until it binds/fails.
  useEffect(() => {
    if (!qrSession) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = (delay: number) => {
      timer = window.setTimeout(async () => {
        if (stopped) return;
        let r: { status: string };
        try {
          r = await pollBotChannelQr(qrSession.sessionId);
        } catch (err) {
          if (stopped) return;
          setQrStatus("failed");
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        if (stopped) return;
        if (r.status === "bound") {
          setQrStatus("bound");
          setConnecting(null);
          setQrSession(null);
          await reload();
        } else if (r.status === "failed") {
          setQrStatus("failed");
        } else {
          setQrStatus(r.status === "scanned" ? "scanned" : "waiting");
          tick(2000);
        }
      }, delay);
    };
    tick(300);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [qrSession, reload]);

  const handleConnect = useCallback(
    async (platform: string) => {
      setBusy(true);
      setError("");
      try {
        await connectBotChannel(agentId, { platform, label: label.trim() || undefined, credential });
        setConnecting(null);
        setCredential("");
        setLabel("");
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentId, credential, label, reload]
  );

  const handleDisconnect = useCallback(
    async (platform: string) => {
      setBusy(true);
      setError("");
      try {
        await disconnectBotChannel(agentId, platform);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentId, reload]
  );

  if (manifests.length === 0) return null;

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
        {manifests.map((m) => {
          const boundLabel = boundPlatforms.get(m.platform);
          const isConnected = boundLabel !== undefined;
          const isConnecting = connecting === m.platform;
          return (
            <div
              key={m.platform}
              className="rounded-lg px-3 py-2"
              style={{ border: "1px solid var(--border)", background: "var(--surface)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm" style={{ color: "var(--text)" }}>
                    {m.displayName}
                    <span
                      className="ml-2 text-xs"
                      style={{ color: isConnected ? "var(--accent)" : "var(--text-muted)" }}
                    >
                      {isConnected
                        ? t("panel.botSettings.channels.connected")
                        : m.availability === "coming-soon"
                          ? t("panel.botSettings.channels.comingSoon")
                          : t("panel.botSettings.channels.notConnected")}
                    </span>
                  </div>
                  {isConnected && (
                    <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                      {boundLabel}
                    </div>
                  )}
                </div>
                {m.availability === "available" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setCredential("");
                      setLabel("");
                      if (isQrPlatform(m)) {
                        void handleQrBegin(m.platform);
                      } else {
                        setConnecting(isConnecting ? null : m.platform);
                      }
                    }}
                  >
                    {isConnected
                      ? t("panel.botSettings.channels.reconnect")
                      : t("panel.botSettings.channels.connect")}
                  </Button>
                )}
              </div>
              {isConnecting &&
                (isQrPlatform(m) ? (
                  <div className="mt-2 flex flex-col gap-2">
                    {qrSession ? (
                      <>
                        <div className="flex justify-center">
                          <img
                            src={qrSession.image}
                            alt={t("panel.botSettings.channels.qr.alt")}
                            width={200}
                            height={200}
                            style={{ borderRadius: 8 }}
                          />
                        </div>
                        <div
                          className="text-xs text-center"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {qrStatus === "scanned"
                            ? t("panel.botSettings.channels.qr.scanned")
                            : qrStatus === "bound"
                              ? t("panel.botSettings.channels.qr.confirmed")
                              : qrStatus === "failed"
                                ? t("panel.botSettings.channels.qr.failed")
                                : t("panel.botSettings.channels.qr.scanning")}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                        {t("panel.botSettings.channels.qr.waiting")}
                      </div>
                    )}
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleQrCancel()}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    {m.connectGuide && (
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                        {m.connectGuide}
                      </div>
                    )}
                    <Input
                      type="password"
                      value={credential}
                      onChange={(e) => setCredential(e.target.value)}
                      placeholder={m.credentialLabel}
                      className="w-full"
                    />
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder={t("panel.botSettings.channels.labelPlaceholder")}
                      className="w-full"
                    />
                    <div className="flex justify-end gap-1.5">
                      {isConnected && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void handleDisconnect(m.platform)}
                        >
                          {t("panel.botSettings.channels.disconnect")}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConnecting(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || !credential.trim()}
                        onClick={() => void handleConnect(m.platform)}
                      >
                        {t("panel.botSettings.channels.save")}
                      </Button>
                    </div>
                  </div>
                ))}
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
  const [view, setView] = useState<"main" | "identity">("main");
  const [item, setItem] = useState<BotListItem | null>(null);
  const [loading, setLoading] = useState(!!agentId);

  // Back to the landing view whenever the panel switches to another bot.
  useEffect(() => {
    setView("main");
  }, [agentId]);

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
    title,
    setTitle,
    description,
    setDescription,
    color,
    setColor,
    emoji,
    setEmoji,
    avatarUrl,
    avatarBusy,
    uploadAvatar,
    removeAvatar,
    model,
    provider,
    selectorModelId,
    handleModelSelect,
    modelGroups,
    modelsLoading,
    nameRef,
  } = useBotContactForm({ active: !!contact, contact, onSaved: handleSaved });

  // Live persistence for the identity sub-page (no save button): every field
  // change is written through after a short debounce. Skipped while the
  // fields still mirror the loaded contact (seed echo) and while the name is
  // empty (config upsert requires one).
  const [liveError, setLiveError] = useState<string | null>(null);
  useEffect(() => {
    if (!contact) return;
    const unchanged =
      name === (contact.name ?? "") &&
      title === (contact.title ?? "") &&
      description === (contact.description ?? "") &&
      color === (contact.avatarColor ?? "blue") &&
      emoji === (contact.avatarEmoji ?? "") &&
      model === (contact.model ?? "") &&
      provider === (contact.provider ?? "");
    if (unchanged || !name.trim()) return;
    const timer = setTimeout(async () => {
      try {
        await updateBotIdentity(contact.agentId, {
          name: name.trim(),
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          avatarColor: color,
          avatarEmoji: emoji.trim() || undefined,
        });
        await updateConfigAgent(contact.agentId, {
          name: name.trim(),
          description: description.trim() || undefined,
          model: model.trim() || undefined,
          provider: provider || undefined,
        });
        setLiveError(null);
        window.dispatchEvent(
          new CustomEvent("duya:bot-identity-updated", { detail: { agentId: contact.agentId } })
        );
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : String(err));
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [contact, name, title, description, color, model, provider]);

  if (!agentId) return <PanelNotice text={t("panel.botSettings.missing")} />;
  if (loading && !item) return <PanelNotice text={t("panel.botSettings.loading")} />;
  if (!item || !contact) return <PanelNotice text={t("panel.botSettings.notFound")} />;

  if (view === "identity") {
    return (
      <div className="bot-settings-panel">
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="sm" onClick={() => setView("main")}>
            <span className="flex items-center gap-1">
              <ArrowLeftIcon size={14} />
              {t("common.back")}
            </span>
          </Button>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {t("panel.botSettings.identity.hint")}
          </span>
        </div>

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
          {t("bot.create.roleTitle")}
        </div>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("bot.create.roleTitlePlaceholder")}
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

        <BotModelSelectorField
          value={selectorModelId}
          groups={modelGroups}
          loading={modelsLoading}
          onChange={handleModelSelect}
          showManageProviders
        />

        <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
          {t("bot.create.avatar")}
        </div>
        {/* Combined emoji + background-color picker (Notion page-icon style). */}
        <div className="flex items-center gap-3 mb-4">
          <BotAvatarPicker
            name={name || "?"}
            agentId={agentId}
            emoji={emoji}
            onEmojiChange={setEmoji}
            color={color}
            onColorChange={setColor}
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

        {liveError && (
          <div className="text-sm" style={{ color: "var(--error, #ef4444)" }}>
            {liveError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bot-settings-panel">
      <div className="flex justify-end mb-2">
        <IconButton
          variant="ghost"
          shape="square"
          size="md"
          aria-label={t("panel.botSettings.identity")}
          title={t("panel.botSettings.identity")}
          onClick={() => setView("identity")}
        >
          <GearSixIcon size={16} />
        </IconButton>
      </div>

      <BotChannelsSection agentId={agentId} />

      <BotRoutinesSection agentId={agentId} />
    </div>
  );
}
