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

import { useEffect, useState } from "react";
import { XIcon, PencilIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { useBotContactForm } from "@/hooks/use-bot-contact-form";
import { BotModelSelectorField } from "./BotModelSelectorField";
import { BOT_AVATAR_COLORS } from "@/lib/bot-avatar";
import { BOT_EMOJI_CATEGORIES } from "@/lib/bot-emoji";
import { BotCharacterAvatar } from "./sidebar/BotCharacterAvatar";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
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

        {/* Top: centered avatar that opens an upload-or-emoji menu on click. */}
        <div
          className="relative mb-4 flex flex-col items-center"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("bot.avatarPicker.label")}
            className="group relative block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <BotCharacterAvatar
              name={name || "?"}
              agentId={contact?.agentId ?? "preview"}
              avatarUrl={avatarUrl}
              avatarColor={color}
              avatarEmoji={emoji}
              size={64}
            />
            <span
              className="absolute inset-0 flex items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              style={{ background: "rgba(0,0,0,0.35)", pointerEvents: "none" }}
              aria-hidden="true"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/90 text-black/80">
                <PencilIcon size={15} />
              </span>
            </span>
          </button>

          {menuOpen && (
            <div
              className="absolute top-full z-30 mt-2 min-w-[150px] rounded-xl border p-1"
              style={{ background: "var(--surface-solid, var(--main-bg))", borderColor: "var(--border)", boxShadow: "0 10px 32px rgba(0,0,0,0.25)" }}
              role="menu"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                disabled={avatarBusy}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
                style={{ color: "var(--text)" }}
                onClick={() => {
                  setMenuOpen(false);
                  void uploadAvatar();
                }}
              >
                {t("bot.avatar.upload")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: "var(--text)" }}
                onClick={() => {
                  setMenuOpen(false);
                  setEmojiOpen((v) => !v);
                }}
              >
                {t("bot.avatar.pickEmoji")}
              </button>
            </div>
          )}

          {emojiOpen && !avatarUrl && (
            <div
              className="mt-2 w-full max-w-[300px] rounded-xl border p-2"
              style={{ background: "var(--surface-solid, var(--main-bg))", borderColor: "var(--border)", maxHeight: 220, overflowY: "auto" }}
              onClick={(e) => e.stopPropagation()}
            >
              {BOT_EMOJI_CATEGORIES.map((cat) => (
                <div key={cat.id}>
                  <div className="px-0.5 pb-0.5 pt-1.5 text-[11px] font-medium" style={{ color: "var(--text-muted)" }}>
                    {t(cat.labelKey)}
                  </div>
                  <div className="grid" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
                    {cat.emojis.map((e) => (
                      <button
                        key={e.char}
                        type="button"
                        onClick={() => {
                          setEmoji(e.char);
                          setEmojiOpen(false);
                        }}
                        className="flex h-8 items-center justify-center rounded-lg text-xl leading-none transition-colors hover:bg-[var(--surface-hover)]"
                        style={{ background: "transparent" }}
                      >
                        {e.char}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Simple color swatches below the avatar (no explicit image). */}
          {!avatarUrl && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {BOT_AVATAR_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.id)}
                  aria-label={c.label}
                  title={c.label}
                  className="rounded-full transition-transform hover:scale-110"
                  style={{
                    width: 22,
                    height: 22,
                    backgroundColor: c.value,
                    outline: color === c.id ? "2px solid var(--text)" : "2px solid transparent",
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
          )}
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
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("bot.create.descriptionPlaceholder")}
          rows={3}
          className="w-full rounded-lg border px-3 py-2.5 text-sm resize-none mb-4 focus:outline-none focus:ring-2 focus:ring-accent/50"
          style={{
            background: "var(--surface)",
            borderColor: "var(--border)",
            color: "var(--text)",
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
