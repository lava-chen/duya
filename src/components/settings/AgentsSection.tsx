"use client";

import { useState, useEffect, useCallback } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import {
  SpinnerGapIcon,
  XIcon,
  CheckCircleIcon,
  PlusIcon,
  TrashIcon,
  NotePencilIcon,
  CheckIcon,
  FeatherIcon,
  RobotIcon,
} from "@/components/icons";
import {
  AGENT_ICON_MAP,
  FALLBACK_AGENT_ICON,
} from "@/components/chat/AgentModeSelector";
import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsSelectRow,
} from "@/components/settings/ui";
import {
  listAgentProfiles,
  type AgentProfile,
} from "@/lib/agent-profile-ipc";
import {
  listOutputStylesIPC,
  upsertOutputStyleIPC,
  deleteOutputStyleIPC,
} from "@/lib/ipc-client";

interface OutputStyle {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  keepCodingInstructions?: boolean;
  isBuiltin?: boolean;
}

export function AgentsSection() {
  const { t } = useTranslation();
  const { settings, loading, save, saving } = useSettings();

  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const languageValue = settings.agentLanguage || '';

  const handleLanguageChange = useCallback(async (value: string) => {
    await save({ agentLanguage: value || undefined });
  }, [save]);

  // Output styles state
  const [outputStyles, setOutputStyles] = useState<OutputStyle[]>([]);
  const [stylesLoading, setStylesLoading] = useState(true);
  const [editingStyle, setEditingStyle] = useState<OutputStyle | null>(null);
  const [isCreatingStyle, setIsCreatingStyle] = useState(false);
  const [styleFormName, setStyleFormName] = useState("");
  const [styleFormDescription, setStyleFormDescription] = useState("");
  const [styleFormPrompt, setStyleFormPrompt] = useState("");
  const [styleFormKeepCoding, setStyleFormKeepCoding] = useState(true);
  const [styleSaving, setStyleSaving] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);

  const loadOutputStyles = useCallback(async () => {
    try {
      setStylesLoading(true);
      const data = await listOutputStylesIPC();
      setOutputStyles(data);
    } catch (err) {
      console.error("Failed to load output styles:", err);
    } finally {
      setStylesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOutputStyles();
  }, [loadOutputStyles]);

  // Load all agent profiles
  useEffect(() => {
    async function loadProfiles() {
      try {
        const data = await listAgentProfiles();
        // Only show enabled profiles, presets first
        const sorted = data
          .filter((p) => p.isEnabled)
          .sort((a, b) => {
            if (a.isPreset !== b.isPreset) return a.isPreset ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        setProfiles(sorted);
      } catch (err) {
        console.error("[AgentsSection] Failed to load profiles:", err);
      } finally {
        setProfilesLoading(false);
      }
    }
    loadProfiles();
  }, []);

  // Sync local state with settings
  useEffect(() => {
    if (settings.favoriteAgentIds) {
      setSelectedIds(settings.favoriteAgentIds);
    }
  }, [settings.favoriteAgentIds]);

  // Track changes
  useEffect(() => {
    const current = settings.favoriteAgentIds || [];
    const changed =
      selectedIds.length !== current.length ||
      selectedIds.some((id, i) => id !== current[i]);
    setHasChanges(changed);
  }, [selectedIds, settings.favoriteAgentIds]);

  const toggleSelection = useCallback((profileId: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(profileId)) {
        return prev.filter((id) => id !== profileId);
      }
      if (prev.length >= 3) {
        // Replace the last one if already at max
        return [...prev.slice(0, 2), profileId];
      }
      return [...prev, profileId];
    });
  }, []);

  const handleSave = useCallback(async () => {
    await save({ favoriteAgentIds: selectedIds });
  }, [selectedIds, save]);

  const handleReset = useCallback(() => {
    setSelectedIds(settings.favoriteAgentIds || []);
  }, [settings.favoriteAgentIds]);

  // Output styles CRUD
  const startCreateStyle = () => {
    setStyleFormName("");
    setStyleFormDescription("");
    setStyleFormPrompt("");
    setStyleFormKeepCoding(true);
    setStyleError(null);
    setIsCreatingStyle(true);
    setEditingStyle(null);
  };

  const startEditStyle = (style: OutputStyle) => {
    setStyleFormName(style.name);
    setStyleFormDescription(style.description || "");
    setStyleFormPrompt(style.prompt);
    setStyleFormKeepCoding(style.keepCodingInstructions !== false);
    setStyleError(null);
    setEditingStyle(style);
    setIsCreatingStyle(false);
  };

  const cancelStyleForm = () => {
    setIsCreatingStyle(false);
    setEditingStyle(null);
    setStyleError(null);
  };

  const saveStyle = async () => {
    if (!styleFormName.trim()) {
      setStyleError(t("outputStyles.nameRequired") || "Name is required");
      return;
    }
    if (!styleFormPrompt.trim()) {
      setStyleError(t("outputStyles.promptRequired") || "Prompt is required");
      return;
    }

    setStyleSaving(true);
    setStyleError(null);

    try {
      const id = editingStyle
        ? editingStyle.id
        : styleFormName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

      await upsertOutputStyleIPC({
        id,
        name: styleFormName.trim(),
        description: styleFormDescription.trim() || undefined,
        prompt: styleFormPrompt.trim(),
        keepCodingInstructions: styleFormKeepCoding,
      });

      await loadOutputStyles();
      cancelStyleForm();
    } catch (err) {
      setStyleError(err instanceof Error ? err.message : String(err));
    } finally {
      setStyleSaving(false);
    }
  };

  const deleteStyle = async (id: string) => {
    try {
      await deleteOutputStyleIPC(id);
      await loadOutputStyles();
    } catch (err) {
      console.error("Failed to delete style:", err);
    }
  };

  if (loading || profilesLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">
          {t("common.loading")}
        </span>
      </div>
    );
  }

  const selectedProfiles = selectedIds
    .map((id) => profiles.find((p) => p.id === id))
    .filter(Boolean) as AgentProfile[];

  return (
    <div className="settings-section">
      {/* Quick Access Agents Section */}
      <SettingsSection
        title={t("settings.agents.quickAccessTitle")}
        description={t("settings.agents.quickAccessDesc")}
      >
        <SettingsCard>
          {/* Selected favorites preview */}
          <div className="px-4 py-3.5">
            <label className="text-sm font-medium text-foreground block mb-2">
              {t("settings.agents.selectedAgents")}
              <span className="text-xs text-muted-foreground font-normal ml-2">
                ({selectedIds.length}/3)
              </span>
            </label>
            {selectedProfiles.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {selectedProfiles.map((profile, index) => {
                  const Icon = AGENT_ICON_MAP[profile.id] || FALLBACK_AGENT_ICON;
                  return (
                  <div
                    key={profile.id}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/5 text-sm"
                  >
                    <span className="text-xs w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-accent font-medium">
                      {index + 1}
                    </span>
                    <Icon size={16} className="text-foreground" />
                    <span className="text-foreground font-medium">
                      {profile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleSelection(profile.id)}
                      className="ml-1 p-0.5 hover:bg-accent/20 rounded transition-colors"
                    >
                      <XIcon size={12} className="text-muted-foreground" />
                    </button>
                  </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("settings.agents.noAgentsSelected")}
              </p>
            )}
          </div>

          {/* Available agents grid */}
          <div className="px-4 py-3.5">
            <label className="text-sm font-medium text-foreground block mb-3">
              {t("settings.agents.availableAgents")}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {profiles.map((profile) => {
                const isSelected = selectedIds.includes(profile.id);
                const selectionIndex = selectedIds.indexOf(profile.id);
                const Icon = AGENT_ICON_MAP[profile.id] || FALLBACK_AGENT_ICON;

                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => toggleSelection(profile.id)}
                    className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-all duration-200 hover:scale-[1.01] ${
                      isSelected
                        ? "border-accent ring-1 ring-accent bg-accent/5"
                        : "border-border/50 bg-surface/50 hover:border-accent/30"
                    }`}
                  >
                    <Icon size={20} className="text-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {profile.name}
                        </span>
                        {profile.isPreset && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                            {t("settings.agents.preset")}
                          </span>
                        )}
                      </div>
                      {profile.description && (
                        <p className="text-xs text-muted-foreground truncate">
                          {profile.description}
                        </p>
                      )}
                    </div>
                    {isSelected && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-xs w-5 h-5 rounded-full bg-accent flex items-center justify-center text-white font-medium">
                          {selectionIndex + 1}
                        </span>
                        <CheckCircleIcon
                          size={16}
                          className="text-accent"
                        />
                      </div>
                    )}
                    {!isSelected && selectedIds.length >= 3 && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {t("settings.agents.maxReached")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {profiles.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <RobotIcon size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  {t("settings.agents.noProfiles")}
                </p>
              </div>
            )}
          </div>

          {hasChanges && (
            <SettingsCardFooter>
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || selectedIds.length === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <SpinnerGapIcon size={14} className="animate-spin" />
                ) : (
                  <CheckCircleIcon size={14} />
                )}
                {saving ? t("common.loading") : t("common.save")}
              </button>
            </SettingsCardFooter>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Response Language Section */}
      <SettingsSection
        title={t("settings.agents.responseLanguage")}
        description={t("settings.agents.responseLanguageDesc")}
      >
        <SettingsCard>
          <SettingsSelectRow
            label={t("settings.agents.responseLanguage")}
            description={t("settings.agents.responseLanguageDesc")}
            value={languageValue}
            onValueChange={handleLanguageChange}
            options={[
              { value: '', label: t('settings.agents.responseLanguageAuto') },
              { value: 'Chinese', label: t('settings.agents.responseLanguageChinese') },
              { value: 'English', label: t('settings.agents.responseLanguageEnglish') },
              { value: 'Japanese', label: t('settings.agents.responseLanguageJapanese') },
              { value: 'Korean', label: t('settings.agents.responseLanguageKorean') },
            ]}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Output Styles Section */}
      <SettingsSection
        title={t("outputStyles.title") || "Output Styles"}
        description={t("outputStyles.description") || "Customize how the AI responds. Select a style in the chat input to apply it."}
      >
        <SettingsCard>
          {(isCreatingStyle || editingStyle) ? (
            <div className="px-4 py-4 space-y-3">
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">
                  {t("outputStyles.name") || "Name"}
                </label>
                <input
                  type="text"
                  value={styleFormName}
                  onChange={(e) => setStyleFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border/50 bg-surface text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent"
                  placeholder={t("outputStyles.namePlaceholder") || "Style name"}
                  disabled={styleSaving}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">
                  {t("outputStyles.descriptionLabel") || "Description"}
                </label>
                <input
                  type="text"
                  value={styleFormDescription}
                  onChange={(e) => setStyleFormDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border/50 bg-surface text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent"
                  placeholder={t("outputStyles.descriptionPlaceholder") || "Optional description"}
                  disabled={styleSaving}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground block mb-1.5">
                  {t("outputStyles.prompt") || "Prompt"}
                </label>
                <textarea
                  value={styleFormPrompt}
                  onChange={(e) => setStyleFormPrompt(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-border/50 bg-surface text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent resize-vertical"
                  placeholder={t("outputStyles.promptPlaceholder") || "Describe the output style behavior..."}
                  disabled={styleSaving}
                />
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="styleKeepCoding"
                  checked={styleFormKeepCoding}
                  onChange={(e) => setStyleFormKeepCoding(e.target.checked)}
                  className="rounded accent-accent"
                />
                <label htmlFor="styleKeepCoding" className="text-sm text-foreground cursor-pointer">
                  {t("outputStyles.keepCodingInstructions") || "Keep coding instructions"}
                </label>
              </div>
              {styleError && (
                <p className="text-sm text-red-400">{styleError}</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={cancelStyleForm}
                  className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
                  disabled={styleSaving}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={saveStyle}
                  disabled={styleSaving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {styleSaving ? (
                    <SpinnerGapIcon size={14} className="animate-spin" />
                  ) : (
                    <CheckIcon size={14} />
                  )}
                  {styleSaving ? t("common.loading") : t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <>
              {stylesLoading ? (
                <div className="text-sm text-muted-foreground py-4 text-center">
                  {t("common.loading")}
                </div>
              ) : outputStyles.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">
                  {t("outputStyles.empty") || "No output styles configured"}
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {outputStyles.map((style) => (
                    <div key={style.id} className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <FeatherIcon size={18} className="text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">
                            {style.name}
                            {style.isBuiltin && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground ml-2">
                                {t("outputStyles.builtin") || "Built-in"}
                              </span>
                            )}
                          </div>
                          {style.description && (
                            <div className="text-xs text-muted-foreground truncate mt-0.5">
                              {style.description}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditStyle(style)}
                          className="p-1.5 hover:bg-accent/20 rounded transition-colors"
                          aria-label="Edit style"
                        >
                          <NotePencilIcon size={14} className="text-muted-foreground" />
                        </button>
                        {!style.isBuiltin && (
                          <button
                            type="button"
                            onClick={() => deleteStyle(style.id)}
                            className="p-1.5 hover:bg-red-500/20 rounded transition-colors"
                            aria-label="Delete style"
                          >
                            <TrashIcon size={14} className="text-muted-foreground" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-border/30 p-2">
                <button
                  type="button"
                  onClick={startCreateStyle}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/5 transition-colors"
                >
                  <PlusIcon size={14} />
                  {t("outputStyles.create") || "Create output style"}
                </button>
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
