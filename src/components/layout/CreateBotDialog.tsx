"use client";

/**
 * CreateBotDialog — grok-style bot creation (Plan 483, add-bot flow
 * aligned with grok-bot's onboarding "create" step).
 *
 * Fields mirror grok's draft shape:
 *   - template suggestions (tap → fills name + description)
 *   - name (required — submit disabled while empty, like grok)
 *   - description
 *   - avatar character: shape × color (8 × 11, defaults blob/blue)
 *
 * The id is derived from the name (`deriveBotIdFromName`), never
 * user-authored. Submission goes through `config:agents:create`, which
 * seeds the 485 identity layer (profile.json with avatar tokens).
 */

import React, { useEffect, useRef, useState } from "react";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { createConfigAgent } from "@/lib/agent-profile-ipc";
import type { TranslationKey } from "@/i18n";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarShape,
} from "@/lib/bot-avatar";
import { BotCharacterAvatar } from "./sidebar/BotCharacterAvatar";
import { deriveBotIdFromName } from "./sidebar/bot-contacts";

export interface CreateBotDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  /** Called after a bot was created successfully (parent reloads contacts). */
  onCreated: (agentId: string) => void;
  /** Existing bot ids, for collision-free id derivation. */
  existingIds: string[];
}

interface BotTemplate {
  id: string;
  nameKey: TranslationKey;
  descKey: TranslationKey;
  shape: BotAvatarShape;
  color: string;
}

const BOT_TEMPLATES: readonly BotTemplate[] = [
  { id: "researcher", nameKey: "bot.template.researcher.name", descKey: "bot.template.researcher.desc", shape: "hex", color: "blue" },
  { id: "chief-of-staff", nameKey: "bot.template.chiefOfStaff.name", descKey: "bot.template.chiefOfStaff.desc", shape: "squircle", color: "violet" },
  { id: "inbox-triage", nameKey: "bot.template.inboxTriage.name", descKey: "bot.template.inboxTriage.desc", shape: "tablet", color: "cyan" },
  { id: "night-shift", nameKey: "bot.template.nightShift.name", descKey: "bot.template.nightShift.desc", shape: "cloud", color: "gray" },
  { id: "lookout", nameKey: "bot.template.lookout.name", descKey: "bot.template.lookout.desc", shape: "teardrop", color: "green" },
  { id: "prototyper", nameKey: "bot.template.prototyper.name", descKey: "bot.template.prototyper.desc", shape: "blob", color: "orange" },
  { id: "shopper", nameKey: "bot.template.shopper.name", descKey: "bot.template.shopper.desc", shape: "pebble", color: "magenta" },
  { id: "digest", nameKey: "bot.template.digest.name", descKey: "bot.template.digest.desc", shape: "wedge", color: "yellow" },
];

export function CreateBotDialog({ isOpen, onCancel, onCreated, existingIds }: CreateBotDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shape, setShape] = useState<BotAvatarShape>("blob");
  const [color, setColor] = useState("blue");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName("");
      setDescription("");
      setShape("blob");
      setColor("blue");
      setSubmitting(false);
      setError(null);
      setTimeout(() => nameRef.current?.focus(), 80);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const canSubmit = name.trim().length > 0 && !submitting;

  const applyTemplate = (template: BotTemplate) => {
    setName(t(template.nameKey));
    setDescription(t(template.descKey));
    setShape(template.shape);
    setColor(template.color);
  };

  const handleCreate = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = deriveBotIdFromName(name, existingIds);
      await createConfigAgent(id, {
        name: name.trim(),
        description: description.trim() || undefined,
        avatarShape: shape,
        avatarColor: color,
      });
      onCreated(id);
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
      aria-label={t("bot.create.title")}
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
            {t("bot.create.title")}
          </h3>
          <Button variant="ghost" size="sm" onClick={onCancel} aria-label={t("bot.create.close")}>
            <XIcon size={16} />
          </Button>
        </div>

        <div className="text-xs font-medium mb-2" style={{ color: "var(--muted)" }}>
          {t("bot.create.templates")}
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {BOT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => applyTemplate(template)}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:opacity-90"
              style={{ background: "var(--surface-hover)", border: "1px solid var(--border)" }}
            >
              <BotCharacterAvatar
                name={t(template.nameKey)}
                agentId={template.id}
                avatarShape={template.shape}
                avatarColor={template.color}
                size={22}
              />
              <span className="min-w-0">
                <span className="block text-sm truncate" style={{ color: "var(--text)" }}>
                  {t(template.nameKey)}
                </span>
                <span className="block text-xs truncate" style={{ color: "var(--muted)" }}>
                  {t(template.descKey)}
                </span>
              </span>
            </button>
          ))}
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
            {t("bot.create.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit}>
            {t("bot.create.create")}
          </Button>
        </div>
      </div>
    </div>
  );
}
