"use client";

import { useState, useEffect, useRef } from "react";
import {
  XIcon,
  SpinnerGapIcon,
  GlobeIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  XCircleIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ChannelIcon, CHANNEL_COLORS } from "@/components/bridge/ChannelIcon";
import type { ChannelId } from "@/components/bridge/channel-defs";
import { CHANNEL_METAS, SETTINGS_KEYS } from "@/components/bridge/channel-defs";

interface ChannelConnectDialogProps {
  channel: ChannelId;
  onClose: () => void;
  onConnected: () => void;
}

const POLL_INTERVAL_MS = 3000;

export function ChannelConnectDialog({ channel, onClose, onConnected }: ChannelConnectDialogProps) {
  const { t } = useTranslation();
  const meta = CHANNEL_METAS[channel];
  const keys = SETTINGS_KEYS[channel];

  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState<string>("");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // React StrictMode mounts components twice in dev, which would otherwise
  // fire the mount-time `startQrLogin()` twice and waste one device_code
  // mint on Feishu's auth server. Guard the in-flight call with a ref so the
  // second mount becomes a no-op until the first call settles.
  const qrInFlightRef = useRef(false);

  const clearPoll = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (meta.connectMode === "qr" && !qrInFlightRef.current) {
      qrInFlightRef.current = true;
      void startQrLogin().finally(() => {
        qrInFlightRef.current = false;
      });
    }
    return clearPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // WeChat QR login — reuses electron/services/network/wechat-qr.ts
  const startQrLogin = async () => {
    setLoading(true);
    setError(null);
    setQrStatus("");
    try {
      if (channel === "weixin") {
        const data = await window.electronAPI?.net?.weixinQrStart();
        if (!data || !data.success) {
          throw new Error(data?.error || "Failed to start QR login");
        }
        setQrImage(data.qrImage ?? null);
        setQrStatus("waiting");
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(() => pollWeixinQr(data.sessionId!), POLL_INTERVAL_MS);
      } else if (channel === "feishu") {
        const data = await window.electronAPI?.gateway?.feishuQrBegin() as {
          success: boolean;
          device_code?: string;
          qr_url?: string;
          interval?: number;
          expire_in?: number;
          error?: string;
        } | undefined;
        if (!data?.success || !data.device_code) {
          throw new Error(data?.error || "Failed to start QR registration");
        }
        setQrStatus("waiting");
        if (data.qr_url) {
          const cleanQrUrl = data.qr_url.replace(/^[`\s]+|[`\s]+$/g, "");
          setQrImage(
            `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(cleanQrUrl)}`,
          );
        }
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(
          () => pollFeishuQr({ device_code: data.device_code! }),
          POLL_INTERVAL_MS,
        );
      }
    } catch (err) {
      setQrStatus("failed");
      setError(err instanceof Error ? err.message : "Failed to start QR login");
    } finally {
      setLoading(false);
    }
  };

  const pollWeixinQr = async (sessionId: string) => {
    try {
      const data = await window.electronAPI?.net?.weixinQrPoll(sessionId);
      if (!data || !data.success) {
        clearPoll();
        setQrStatus("failed");
        return;
      }
      setQrStatus(data.status ?? "");
      if (data.qr_image && data.status === "waiting") {
        setQrImage(data.qr_image);
      }
      if (data.status === "confirmed" || data.status === "failed") {
        clearPoll();
        if (data.status === "confirmed") {
          await finishConnect([[keys.enabled, "true"]]);
        } else {
          setError(t("bridge.loginFailed"));
        }
      }
    } catch {
      clearPoll();
      setQrStatus("failed");
    }
  };

  const pollFeishuQr = async (begin: { device_code: string; interval?: number; expire_in?: number }) => {
    try {
      const data = await window.electronAPI?.gateway?.feishuQrPoll({
        device_code: begin.device_code,
        interval: 5,
        expire_in: 600,
      }) as {
        success: boolean;
        app_id?: string;
        app_secret?: string;
        error?: string;
      } | undefined;
      if (!data?.success) {
        clearPoll();
        setQrStatus("failed");
        return;
      }
      if (data.app_id) {
        clearPoll();
        setQrStatus("confirmed");
        await finishConnect([
          [keys.enabled, "true"],
          [keys.appId, data.app_id],
          [keys.appSecret, data.app_secret ?? ""],
        ]);
      } else {
        setQrStatus("waiting");
      }
    } catch {
      clearPoll();
      setQrStatus("failed");
    }
  };

  const cancelQr = () => {
    clearPoll();
    onClose();
  };

  /** Persist settings, reload the gateway once, then signal success. */
  const finishConnect = async (entries: Array<[string, string]>) => {
    setSaving(true);
    setError(null);
    try {
      for (const [key, value] of entries) {
        await window.electronAPI?.settingsDb?.set(key, value);
      }
      try {
        await window.electronAPI?.gateway?.reload();
      } catch {
        // Gateway may be offline — settings are already saved.
      }
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save connection");
      setSaving(false);
    }
  };

  const submitForm = async () => {
    setSaving(true);
    setError(null);
    const entries: Array<[string, string]> = [];
    if (channel === "telegram") {
      const token = (formValues["token"] ?? "").trim();
      if (!token) {
        setError(t("gateway.tokenRequired"));
        setSaving(false);
        return;
      }
      entries.push([keys.token, token]);
    } else if (channel === "qq") {
      const appId = (formValues["appId"] ?? "").trim();
      const appSecret = (formValues["appSecret"] ?? "").trim();
      if (!appId || !appSecret) {
        setError(t("gateway.credentialsRequired"));
        setSaving(false);
        return;
      }
      entries.push([keys.appId, appId], [keys.appSecret, appSecret]);
    } else if (channel === "whatsapp") {
      entries.push([keys.sessionPath, (formValues["sessionPath"] ?? "").trim()]);
    }
    entries.push([keys.enabled, "true"]);
    await finishConnect(entries);
  };

  const formFields =
    channel === "telegram"
      ? [
          { key: "token", label: t("bridge.botToken"), placeholder: "123456:ABC-DEF...", type: "password" as const },
        ]
      : channel === "qq"
        ? [
            { key: "appId", label: t("bridge.appId"), placeholder: "1023456789" },
            { key: "appSecret", label: t("bridge.appSecret"), placeholder: "xxxxxxxx...", type: "password" as const },
          ]
        : [
            { key: "sessionPath", label: "Session Path", placeholder: "~/.duya/whatsapp-session" },
          ];

  const showQr = meta.connectMode === "qr" && qrImage;

  return (
    <div className="channel-dialog-overlay" onClick={onClose}>
      <div
        className="channel-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-dialog-title"
      >
        {/* Header */}
        <div className="channel-dialog-header">
          <div className="flex items-center gap-2.5">
            <div
              className="channel-list-icon"
              style={{
                backgroundColor: CHANNEL_COLORS[channel].bgColor,
                color: CHANNEL_COLORS[channel].color,
              }}
            >
              <ChannelIcon channel={channel} size={18} />
            </div>
            <div className="flex flex-col">
              <span id="channel-dialog-title" className="text-sm font-medium">
                {t("gateway.connectChannel", { name: meta.name })}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {meta.connectMode === "qr" ? t("gateway.scanToConnect") : t("gateway.enterCredentials")}
              </span>
            </div>
          </div>
          <button type="button" className="channel-dialog-close" onClick={onClose} aria-label={t("bridge.cancel")}>
            <XIcon size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="channel-dialog-body">
          {error && (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {showQr ? (
            <div className="flex flex-col items-center gap-3">
              <img
                src={qrImage}
                alt={`${meta.name} QR Code`}
                className="h-52 w-52 rounded-lg border border-border/30 bg-white p-1.5"
              />
              <div className="flex items-center justify-center gap-2 text-sm min-h-[1.5rem]">
                {qrStatus === "waiting" && (
                  <>
                    <SpinnerGapIcon size={14} className="animate-spin text-blue-500" />
                    <span className="text-blue-500">{t("bridge.waitingForScan")}</span>
                  </>
                )}
                {qrStatus === "scanned" && (
                  <>
                    <CheckCircleIcon size={14} className="text-blue-500" />
                    <span className="text-blue-500">{t("bridge.scanned")}</span>
                  </>
                )}
                {qrStatus === "confirmed" && (
                  <>
                    <CheckCircleIcon size={14} className="text-green-500" />
                    <span className="text-green-500">{t("bridge.loginSuccess")}</span>
                  </>
                )}
                {qrStatus === "expired" && (
                  <>
                    <CircleNotchIcon size={14} className="text-yellow-500" />
                    <span className="text-yellow-500">{t("bridge.qrExpired")}</span>
                  </>
                )}
                {qrStatus === "failed" && (
                  <>
                    <XCircleIcon size={14} className="text-destructive" />
                    <span className="text-destructive">{t("bridge.loginFailed")}</span>
                  </>
                )}
              </div>
            </div>
          ) : meta.connectMode === "qr" ? (
            <div className="flex flex-col items-center gap-3 py-4">
              {loading ? (
                <SpinnerGapIcon size={24} className="animate-spin text-muted-foreground" />
              ) : (
                <>
                  <GlobeIcon size={24} className="text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t("gateway.scanToConnect")}</p>
                  <Button variant="primary" size="sm" onClick={() => void startQrLogin()}>
                    {t("gateway.connect")}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {formFields.map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
                  <Input
                    type={field.type ?? "text"}
                    value={formValues[field.key] ?? ""}
                    onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="channel-dialog-footer">
          {showQr || meta.connectMode === "qr" ? (
            <Button variant="secondary" size="sm" onClick={cancelQr} disabled={saving}>
              {t("bridge.cancel")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
                {t("bridge.cancel")}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void submitForm()} disabled={saving}>
                {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : <GlobeIcon size={14} />}
                {t("gateway.saveAndConnect")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
