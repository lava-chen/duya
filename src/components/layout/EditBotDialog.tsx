"use client";

/**
 * EditBotDialog — grok-style bot identity editing (Plan 483 P2).
 *
 * Edits the runtime identity of an existing bot: name, description and
 * avatar character (shape × color). Writes go through
 * `config:agents:updateBotProfile` → `agents/<id>/profile.json` (the
 * runtime identity source, plan 485 §2.4), so sidebar + settings reflect
 * the change without rewriting config.toml.
 */

import { useEffect, useRef, useState } from "react";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { updateBotIdentity } from "@/lib/agent-profile-ipc";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarShape,
} from "@/lib/bot-avatar";
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shape, setShape] = useState<BotAvatarShape>("blob");
  const [color, setColor] = useState("blue");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen && contact) {
      setName(contact.name);
      setDescription(contact.description ?? "");
      setShape((contact.avatarShape as BotAvatarShape) ?? "blob");
      setColor(contact.avatarColor ?? "blue");
      setSubmitting(false);
      setError(null);
      setTimeout(() => nameRef.current?.focus(), 80);
    }
  }, [isOpen, contact]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onCancel]);

  if (!isOpen || !contact) return null;

  const canSubmit = name.trim().length > 0 && !submitting;

  const handleSave = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateBotIdentity(contact.agentId, {
        name: name.trim(),
        description: description.trim() || undefined,
        avatarShape: shape,
        avatarColor: color,
      });
      onSaved(contact.agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
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

        <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
          {t("bot.create.avatar")}
        </div>
        <div className="flex items-center gap-3 mb-3">
          <BotCharacterAvatar name={name || "?"} agentId="preview" avatarShape={shape} avatarColor={color} size={34} />
          <div className="flex flex-wrap gap-1.5">
            {BOT_AVATAR_SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setShape(s)}
                aria-label={s}
                className="rounded-md p-1 transition-colors"
                style={{
                  background: shape === s ? "var(--surface-hover)" : "transparent",
                  outline: shape === s ? "2px solid var(--accent)" : "none",
                }}
              >
                <BotCharacterAvatar name={s} agentId={s} avatarShape={s} avatarColor={color} size={20} />
              </button>
            ))}
          </div>
        </div>
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
