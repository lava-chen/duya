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
import { AutoResizeTextarea } from "@/components/ui/AutoResizeTextarea";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotContactForm } from "@/hooks/use-bot-contact-form";
import { BotAvatarEditor } from "./BotAvatarEditor";
import { BotModelSelectorField } from "./BotModelSelectorField";
import type { BotContact } from "./sidebar/bot-contacts";

/** iOS-style edit-field label: small muted text sitting above its control. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1" style={{ color: "var(--text-muted)", fontSize: 13 }}>
      {children}
    </div>
  );
}

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
    selectorModelId,
    handleModelSelect,
    modelGroups,
    modelsLoading,
    submitting,
    error,
    canSubmit,
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

        {/* Top: centered avatar editor (upload / emoji / color). */}
        <div className="mb-4">
          <BotAvatarEditor
            name={name || "?"}
            agentId={contact?.agentId ?? "preview"}
            emoji={emoji}
            onEmojiChange={setEmoji}
            color={color}
            onColorChange={setColor}
            avatarUrl={avatarUrl}
            avatarBusy={avatarBusy}
            onUpload={() => void uploadAvatar()}
          />
        </div>

        <FieldLabel>{t("bot.create.name")}</FieldLabel>
        <Input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("bot.create.namePlaceholder")}
          className="mb-3 h-11"
        />

        <FieldLabel>{t("bot.create.roleTitle")}</FieldLabel>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("bot.create.roleTitlePlaceholder")}
          className="mb-3 h-11"
        />

        <FieldLabel>{t("bot.create.description")}</FieldLabel>
        <AutoResizeTextarea
          value={description}
          onChange={setDescription}
          maxHeight={160}
          placeholder={t("bot.create.descriptionPlaceholder")}
          className="w-full rounded-lg border px-3 py-2 text-sm textarea-resize-none mb-4 focus:outline-none focus:ring-2 focus:ring-accent/50"
          style={{
            background: "var(--surface)",
            borderColor: "var(--border)",
            color: "var(--text)",
            resize: "none",
          }}
        />

        <BotModelSelectorField
          value={selectorModelId}
          groups={modelGroups}
          loading={modelsLoading}
          onChange={handleModelSelect}
        />

        {avatarUrl && (
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" size="sm" disabled={avatarBusy} onClick={() => void removeAvatar()}>
              {t("bot.avatar.remove")}
            </Button>
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
