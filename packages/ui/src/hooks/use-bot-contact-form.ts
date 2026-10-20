"use client";

/**
 * use-bot-contact-form — shared edit-form state for a bot's runtime
 * identity (name, description, color, model).
 *
 * Extracted from EditBotDialog so the dialog and the bot-settings side
 * panel (plan 483 P2.1c) render the same fields over the same save path:
 * identity → `agents/<id>/profile.json` (updateBotIdentity), then model →
 * config.toml (updateConfigAgent) — the runtime identity source from
 * plan 485 §2.4.
 *
 * The form seeds once per contact id while `active`. It deliberately does
 * NOT re-seed when the contact object identity changes: merged contact
 * lists are rebuilt on thread updates, and re-seeding on every rebuild
 * would wipe in-progress edits while the bound session is streaming.
 */

import { useEffect, useRef, useState } from "react";
import { updateBotIdentity, updateConfigAgent } from "@/lib/agent-profile-ipc";
import { listProvidersIPC } from "@/lib/ipc-client";
import {
  buildBotModelGroups,
  fromSelectorModelId,
  toSelectorModelId,
} from "@/lib/bot-model-options";
import type { ProviderModelGroup } from "@/components/chat/ModelProviderSelector";
import type { BotContact } from "@/components/layout/sidebar/bot-contacts";

export interface UseBotContactFormOptions {
  /** Seeds the form and loads model options; false holds defaults. */
  active: boolean;
  /** The bot being edited (null until the host resolves it). */
  contact: BotContact | null;
  /** Called after a successful save (hosts reload their contact lists). */
  onSaved?: (agentId: string) => void;
}

export function useBotContactForm({ active, contact, onSaved }: UseBotContactFormOptions) {
  const [name, setName] = useState("");
  /** Role subtitle (profile.json `title`, 485 §2.4 — host-managed, display only). */
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("blue");
  const [model, setModel] = useState("");
  /** Provider store id the configured `model` belongs to ('' = none). */
  const [provider, setProvider] = useState("");
  /** Thinking level bound to the model; undefined → runtime default medium. */
  const [reasoning, setReasoning] = useState<'off' | 'low' | 'medium' | 'high' | undefined>(undefined);
  const [modelGroups, setModelGroups] = useState<ProviderModelGroup[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // Which contact the current field values belong to. Guard both the seed
  // effect and `save` so a closed/reset host never writes a half-seeded
  // form back to config.
  const seededForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      // Re-arm so the next activation seeds fresh values (dialog reopen).
      seededForRef.current = null;
      return;
    }
    if (!contact || seededForRef.current === contact.agentId) return;
    seededForRef.current = contact.agentId;
    setName(contact.name);
    setTitle(contact.title ?? "");
    setDescription(contact.description ?? "");
    setColor(contact.avatarColor ?? "blue");
    setModel(contact.model ?? "");
    setProvider(contact.provider ?? "");
    setReasoning(contact.reasoning);
    setSubmitting(false);
    setError(null);
    setTimeout(() => nameRef.current?.focus(), 80);
    // Load model options (best-effort; failure must not block saving).
    setModelsLoading(true);
    listProvidersIPC()
      .then((providers) => setModelGroups(buildBotModelGroups(providers)))
      .catch(() => setModelGroups([]))
      .finally(() => setModelsLoading(false));
  }, [active, contact]);

  const canSubmit =
    name.trim().length > 0 &&
    !submitting &&
    !!contact &&
    seededForRef.current === contact.agentId;

  // ModelSelector state: the raw configured model + provider map to a
  // prefixed selector id for display; a stale model (no longer exposed by
  // any provider) falls back to displaying the raw id, so saving without
  // touching the field preserves it.
  const selectorModelId = toSelectorModelId(model, provider || undefined, modelGroups);
  const handleModelSelect = (selectorId: string) => {
    const { raw, providerId } = fromSelectorModelId(selectorId, modelGroups);
    setModel(raw);
    setProvider(providerId ?? "");
  };

  const save = async (): Promise<boolean> => {
    if (!contact || !canSubmit) return false;
    setSubmitting(true);
    setError(null);
    try {
      // Identity first (profile.json), then the model (config.toml) — if the
      // identity write fails we must not leave the config half-updated.
      await updateBotIdentity(contact.agentId, {
        name: name.trim(),
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        avatarColor: color,
      });
      await updateConfigAgent(contact.agentId, {
        name: name.trim(),
        description: description.trim() || undefined,
        model: model.trim() || undefined,
        provider: provider || undefined,
        reasoning,
      });
      onSaved?.(contact.agentId);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  return {
    name,
    setName,
    title,
    setTitle,
    description,
    setDescription,
    color,
    setColor,
    model,
    provider,
    /** Thinking level bound to the model (undefined → runtime default medium). */
    reasoning,
    setReasoning,
    /** Prefixed selector id derived from model+provider (raw fallback for stale configs). */
    selectorModelId,
    handleModelSelect,
    modelGroups,
    modelsLoading,
    submitting,
    error,
    canSubmit,
    nameRef,
    save,
  };
}

export type BotContactForm = ReturnType<typeof useBotContactForm>;
