"use client";

/**
 * EditBotDialog — bot identity editing (Plan 483 P2; avatar revised
 * 2026-09-24: the animated agent face replaced the uploaded image + emoji
 * tile, only the body color token stays editable).
 *
 * Edits the runtime identity of an existing bot: name, description, and
 * the face's color token. Form state and the save path live in
 * `useBotContactForm` (shared with the bot-settings side panel, P2.1c);
 * this component owns the modal chrome and the Escape/overlay dismissal.
 */

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AutoResizeTextarea } from "@/components/ui/AutoResizeTextarea";
import { Modal } from "@/components/ui/page";
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
    selectorModelId,
    handleModelSelect,
    modelGroups,
    modelsLoading,
    reasoning,
    setReasoning,
    error,
    canSubmit,
    nameRef,
    save,
  } = useBotContactForm({ active: isOpen, contact, onSaved });

  if (!isOpen || !contact) return null;

  const handleSave = async () => {
    // The hook resets `submitting` in its finally block, so closing on
    // success never leaves a stuck pending state behind.
    if (await save()) onCancel();
  };

  return (
    <Modal
      open={isOpen}
      onClose={onCancel}
      title={t("bot.edit.title")}
      size="sm"
      className="edit-bot-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t("bot.edit.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {t("bot.edit.save")}
          </Button>
        </>
      }
    >
      {/* Top: centered face preview + body-color swatches. */}
      <div className="mb-4">
        <BotAvatarEditor
          name={name || "?"}
          agentId={contact?.agentId ?? "preview"}
          color={color}
          onColorChange={setColor}
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
        reasoning={reasoning}
        onReasoningChange={setReasoning}
      />

      {error && (
        <div className="text-sm mb-3" style={{ color: "var(--error, #ef4444)" }}>
          {error}
        </div>
      )}
    </Modal>
  );
}