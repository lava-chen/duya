"use client";

/**
 * EditBotDialog — bot identity editing (Plan 483 P2; avatar revised
 * 2026-09-05: image upload + color circle, shape tokens removed).
 *
 * Edits the runtime identity of an existing bot: name, description, avatar
 * (uploaded image via the main-process file dialog, or a color token for
 * the initial circle). Form state and the save path live in
 * `useBotContactForm` (shared with the bot-settings side panel, P2.1c);
 * this component owns the modal chrome and the Escape/overlay dismissal.
 */

import { useEffect } from "react";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotContactForm } from "@/hooks/use-bot-contact-form";
import { BotModelField } from "./BotModelField";
import { BOT_AVATAR_COLORS } from "@/lib/bot-avatar";
import { BotCharacterAvatar } from "./sidebar/BotCharacterAvatar";
import type { BotContact } from "./sidebar/bot-contacts";

export interface EditBotDialogProps {
  isOpen: boolean;
  /** The bot being edited (null/undefined while closed). */
  contact: BotContact | null;
  onCancel: () => void;
  /** Called after a successful save (parent reloads contacts). */
  onSaved: (agentId: string) => void;
}

export function EditBotDialog({ isOpen, contact, onCancel, onSaved }: EditBotDialogProps) {
  const { t } = useTranslation();
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
  } = useBotContactForm({ active: isOpen, contact, onSaved });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onCancel]);

  if (!isOpen || !contact) return null;

  const handleSave = async () => {
    // The hook resets `submitting` in its finally block, so closing on
    // success never leaves a stuck pending state behind.
    if (await save()) onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={t("bot.edit.title")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl p-6 shadow-xl overflow-y-auto"
        style={{
          background: "var(--bg-canvas, var(--surface))",
          border: "1px solid var(--border)",
          maxHeight: "85vh",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium" style={{ color: "var(--text)" }}>
            {t("bot.edit.title")}
          </h3>
          <Button variant="ghost" size="sm" onClick={onCancel} aria-label={t("bot.edit.close")}>
            <XIcon size={16} />
          </Button>
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
            agentId={contact?.agentId ?? "preview"}
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

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t("bot.edit.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {t("bot.edit.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
