"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  FolderIcon,
  SearchIcon,
  XIcon,
  CheckIcon,
  WrenchIcon,
  ShieldIcon,
  WarningIcon,
  ProhibitIcon,
  SpinnerGapIcon,
  LightningIcon,
} from "@/components/icons";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from "@/components/settings/ui";
import { useTranslation } from "@/hooks/useTranslation";

interface SkillFinding {
  patternId: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  file: string;
  line: number;
  match: string;
  description: string;
}

interface SkillSecurity {
  verdict: "safe" | "caution" | "dangerous";
  findings: SkillFinding[];
  scanned: boolean;
}

interface SkillMetadata {
  name: string;
  description: string;
  category?: string;
  source?: string;
  userInvocable?: boolean;
  whenToUse?: string;
  allowedTools?: string[];
  platforms?: string[];
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface SkillWithContent extends SkillMetadata {
  content: string;
  frontmatter: Record<string, unknown>;
  security?: SkillSecurity;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string; icon: string }> = {
  development: { bg: "rgba(59, 130, 246, 0.1)", text: "#3b82f6", border: "rgba(59, 130, 246, 0.3)", icon: "💻" },
  research: { bg: "rgba(168, 85, 247, 0.1)", text: "#a855f7", border: "rgba(168, 85, 247, 0.3)", icon: "🔬" },
  creative: { bg: "rgba(236, 72, 153, 0.1)", text: "#ec4899", border: "rgba(236, 72, 153, 0.3)", icon: "🎨" },
  productivity: { bg: "rgba(34, 197, 94, 0.1)", text: "#22c55e", border: "rgba(34, 197, 94, 0.3)", icon: "⚡" },
  automation: { bg: "rgba(245, 158, 11, 0.1)", text: "#f59e0b", border: "rgba(245, 158, 11, 0.3)", icon: "🤖" },
  communication: { bg: "rgba(14, 165, 233, 0.1)", text: "#0ea5e9", border: "rgba(14, 165, 233, 0.3)", icon: "💬" },
  media: { bg: "rgba(239, 68, 68, 0.1)", text: "#ef4444", border: "rgba(239, 68, 68, 0.3)", icon: "🎬" },
  mcp: { bg: "rgba(99, 102, 241, 0.1)", text: "#6366f1", border: "rgba(99, 102, 241, 0.3)", icon: "🔌" },
  system: { bg: "rgba(107, 114, 128, 0.1)", text: "#6b7280", border: "rgba(107, 114, 128, 0.3)", icon: "⚙️" },
  other: { bg: "rgba(156, 163, 175, 0.1)", text: "#9ca3af", border: "rgba(156, 163, 175, 0.3)", icon: "📦" },
};

function getCategoryColor(category?: string) {
  return CATEGORY_COLORS[category || "other"] || CATEGORY_COLORS.other;
}

function SkillIcon({ category, size = "md" }: { category?: string; size?: "sm" | "md" | "lg" }) {
  const categoryColor = getCategoryColor(category);
  const sizeClasses = {
    sm: "w-8 h-8 text-lg",
    md: "w-10 h-10 text-xl",
    lg: "w-12 h-12 text-2xl",
  };

  return (
    <div
      className={`${sizeClasses[size]} rounded-xl flex items-center justify-center flex-shrink-0`}
      style={{
        backgroundColor: categoryColor.bg,
        color: categoryColor.text,
      }}
    >
      {categoryColor.icon}
    </div>
  );
}

function SecurityBadge({ security, source }: { security?: SkillSecurity; source?: string }) {
  const { t } = useTranslation();
  if (!security?.scanned) return null;

  if (source === "bundled") {
    return (
      <span className="flex items-center gap-1 text-[0.7rem] text-emerald-600 dark:text-emerald-400">
        <ShieldIcon size={12} />
        {t('skills.trusted')}
      </span>
    );
  }

  if (security.verdict === "dangerous") {
    return (
      <span className="flex items-center gap-1 text-[0.7rem] text-red-600 dark:text-red-400">
        <ProhibitIcon size={12} />
        {t('skills.blocked')}
      </span>
    );
  }

  if (security.verdict === "caution") {
    return (
      <span className="flex items-center gap-1 text-[0.7rem] text-amber-600 dark:text-amber-400">
        <WarningIcon size={12} />
        {t('skills.caution')}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-[0.7rem] text-emerald-600 dark:text-emerald-400">
      <ShieldIcon size={12} />
      {t('skills.safe')}
    </span>
  );
}

function SkillCard({ skill, isEnabled, onClick }: { skill: SkillWithContent; isEnabled?: boolean; onClick: () => void }) {
  return (
    <div
      className="group p-4 rounded-xl border border-border/50 bg-surface/50 hover:border-accent/30 hover:bg-accent/[0.02] hover:shadow-sm hover:-translate-y-0.5 transition-all duration-200 cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <SkillIcon category={skill.category} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground leading-tight truncate">{skill.name}</h3>
            <SecurityBadge security={skill.security} source={skill.source} />
          </div>
          <p className="text-xs text-muted-foreground leading-[1.4] line-clamp-1 mt-0.5">{skill.description}</p>
        </div>
        {isEnabled && (
          <div className="w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
            <CheckIcon size={14} className="text-accent" />
          </div>
        )}
      </div>
    </div>
  );
}

function SkillDetailModal({ skill, onClose }: { skill: SkillWithContent; onClose: () => void }) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const [bypassedSkills, setBypassedSkills] = useState<string[]>([]);
  const [isLoadingBypass, setIsLoadingBypass] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && e.target === modalRef.current) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  useEffect(() => {
    const loadBypassList = async () => {
      const win = window as unknown as {
        electronAPI?: { skills?: { getSecurityBypass: () => Promise<{ success: boolean; skills: string[] }> } };
      };
      if (win.electronAPI?.skills?.getSecurityBypass) {
        const result = await win.electronAPI.skills.getSecurityBypass();
        if (result.success) {
          setBypassedSkills(result.skills);
        }
      }
    };
    void loadBypassList();
  }, []);

  const handleToggleBypass = async () => {
    const win = window as unknown as {
      electronAPI?: {
        skills?: { setSecurityBypass: (name: string, bypass: boolean) => Promise<{ success: boolean; skills: string[] }> };
      };
    };
    if (!win.electronAPI?.skills?.setSecurityBypass) return;

    setIsLoadingBypass(true);
    const isBypassed = bypassedSkills.includes(skill.name);
    const result = await win.electronAPI.skills.setSecurityBypass(skill.name, !isBypassed);
    if (result.success) {
      setBypassedSkills(result.skills);
    }
    setIsLoadingBypass(false);
  };

  const metadataFields = [
    { key: t('skills.category'), value: skill.category },
    { key: t('skills.source'), value: skill.source },
    { key: t('skills.userInvocable'), value: skill.userInvocable ? t('skills.yes') : t('skills.no') },
    { key: t('skills.whenToUse'), value: skill.whenToUse },
    { key: t('skills.platforms'), value: skill.platforms?.length ? skill.platforms.join(", ") : undefined },
  ].filter((f) => f.value);

  const categoryColor = getCategoryColor(skill.category);
  const isBypassed = bypassedSkills.includes(skill.name);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" ref={modalRef}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 p-5 border-b border-border/50">
          <SkillIcon category={skill.category} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="text-[0.7rem] font-medium px-2 py-0.5 rounded-full capitalize"
                style={{
                  backgroundColor: categoryColor.bg,
                  color: categoryColor.text,
                  border: `1px solid ${categoryColor.border}`,
                }}
              >
                {skill.category || "other"}
              </span>
              {skill.source && <span className="text-[0.7rem] text-muted-foreground capitalize">{skill.source}</span>}
            </div>
            <h2 className="text-lg font-semibold text-foreground mt-1">{skill.name}</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted transition-colors">
            <XIcon size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">{skill.description}</p>

          {metadataFields.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t('skills.metadata')}</h4>
              <div className="grid grid-cols-2 gap-3">
                {metadataFields.map((field) => (
                  <div key={field.key} className="p-3 rounded-lg bg-muted/30">
                    <span className="text-xs text-muted-foreground block mb-1">{field.key}</span>
                    <span className="text-sm text-foreground capitalize">{String(field.value)}</span>
                  </div>
                ))}
                {skill.allowedTools && skill.allowedTools.length > 0 && (
                  <div className="p-3 rounded-lg bg-muted/30 col-span-2">
                    <span className="text-xs text-muted-foreground block mb-2">{t('skills.allowedTools')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {skill.allowedTools.map((tool) => (
                        <span key={tool} className="text-xs px-2 py-1 rounded-md bg-surface border border-border/50 text-foreground">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {skill.security?.scanned && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t('skills.securityStatus')}</h4>
              <div className="rounded-lg border border-border/50 p-4">
                <div className="flex items-center gap-2 mb-3">
                  {skill.source === "bundled" ? (
                    <>
                      <ShieldIcon size={18} className="text-green-500" />
                      <span className="text-sm font-medium text-green-500">{t('skills.trustedBuiltin')}</span>
                    </>
                  ) : skill.security.verdict === "dangerous" ? (
                    <>
                      <ProhibitIcon size={18} className="text-red-500" />
                      <span className="text-sm font-medium text-red-500">{t('skills.blocked')}</span>
                    </>
                  ) : skill.security.verdict === "caution" ? (
                    <>
                      <WarningIcon size={18} className="text-yellow-500" />
                      <span className="text-sm font-medium text-yellow-500">{t('skills.caution')}</span>
                    </>
                  ) : (
                    <>
                      <ShieldIcon size={18} className="text-green-500" />
                      <span className="text-sm font-medium text-green-500">{t('skills.safe')}</span>
                    </>
                  )}
                </div>
                {skill.security.findings.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{t('skills.securityFindings', { count: skill.security.findings.length })}</p>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {skill.security.findings.map((finding, idx) => (
                        <div key={idx} className="text-xs p-2 rounded bg-muted/30">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={`font-medium ${
                                finding.severity === "critical"
                                  ? "text-red-600"
                                  : finding.severity === "high"
                                  ? "text-orange-600"
                                  : finding.severity === "medium"
                                  ? "text-yellow-600"
                                  : "text-blue-600"
                              }`}
                            >
                              {finding.severity.toUpperCase()}
                            </span>
                            <span className="text-muted-foreground">[{finding.category}]</span>
                          </div>
                          <p className="text-foreground">{finding.description}</p>
                          {finding.match && (
                            <code className="block mt-1 text-xs text-muted-foreground bg-surface px-2 py-1 rounded truncate">
                              {finding.match}
                            </code>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {skill.source !== "bundled" && skill.security.verdict !== "safe" && (
                  <div className="mt-4 pt-4 border-t border-border/50">
                    <p className="text-xs text-muted-foreground mb-3">{t('skills.skillBlocked')}</p>
                    <ol className="text-xs text-muted-foreground mb-4 list-decimal list-inside space-y-1">
                      <li>{t('skills.reviewFindings')}</li>
                      <li>{t('skills.orBypass')}</li>
                    </ol>
                    <button
                      onClick={handleToggleBypass}
                      disabled={isLoadingBypass}
                      className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                        isBypassed
                          ? "bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border border-yellow-500/30"
                          : "bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/30"
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {isLoadingBypass ? t('skills.updating') : isBypassed ? t('skills.removeBypass') : t('skills.bypassSecurity')}
                    </button>
                    {isBypassed && (
                      <p className="text-xs text-yellow-500 mt-2">{t('skills.bypassedWarning')}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {skill.content && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t('skills.documentation')}</h4>
              <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none">
                {skill.content}
              </MarkdownRenderer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function groupSkillsByCategory(skills: SkillWithContent[]): Record<string, SkillWithContent[]> {
  const groups: Record<string, SkillWithContent[]> = {};

  skills.forEach((skill) => {
    const category = skill.category || "other";
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(skill);
  });

  const sortedGroups: Record<string, SkillWithContent[]> = {};
  const categories = Object.keys(groups).sort((a, b) => {
    if (a === "system") return -1;
    if (b === "system") return 1;
    return a.localeCompare(b);
  });

  categories.forEach((category) => {
    sortedGroups[category] = groups[category];
  });

  return sortedGroups;
}

export function SkillsSection() {
  const { t } = useTranslation();
  const [skillPath, setSkillPath] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillWithContent | null>(null);
  const [skills, setSkills] = useState<SkillWithContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadSkillPath = async () => {
      const win = window as unknown as {
        electronAPI?: { config?: { get: (key: string) => Promise<unknown> } };
      };
      if (win.electronAPI?.config?.get) {
        const path = await win.electronAPI.config.get("skill_path");
        if (path) setSkillPath(path as string);
      }
    };
    void loadSkillPath();
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const win = window as unknown as {
        electronAPI?: {
          skills?: { list: () => Promise<{ success: boolean; skills: SkillWithContent[]; error?: string }> };
        };
      };

      if (!win.electronAPI?.skills?.list) {
        setError("Skills API not available");
        setLoading(false);
        return;
      }

      const result = await win.electronAPI.skills.list();

      if (result.success) {
        setSkills(result.skills);
      } else {
        setError(result.error || "Failed to load skills");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const query = searchQuery.toLowerCase();
    return skills.filter(
      (skill) =>
        skill.name?.toLowerCase().includes(query) ||
        String(skill.description ?? "").toLowerCase().includes(query) ||
        skill.category?.toLowerCase().includes(query)
    );
  }, [searchQuery, skills]);

  const groupedSkills = useMemo(() => {
    return groupSkillsByCategory(filteredSkills);
  }, [filteredSkills]);

  const handleSelectSkillPath = async () => {
    const win = window as unknown as {
      electronAPI?: {
        dialog?: { openFolder: () => Promise<string | null> };
        config?: { set: (key: string, value: string) => Promise<void> };
      };
    };
    if (win.electronAPI?.dialog?.openFolder) {
      const selected = await win.electronAPI.dialog.openFolder();
      if (selected) {
        setSkillPath(selected);
        await win.electronAPI.config?.set("skill_path", selected);
      }
    }
  };

  return (
    <div className="settings-section">
      {/* Search */}
      <SettingsSection title={t('skills.title')} description={t('skills.description')}>
        <div className="relative mb-6">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <SearchIcon size={18} />
          </div>
          <input
            type="text"
            placeholder={t('skills.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface border border-border/50 rounded-xl py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
          />
        </div>
      </SettingsSection>

      {/* Skill Path Configuration */}
      <SettingsSection title={t('skills.customSkillPath')} description={t('skills.customSkillPathDesc')}>
        <SettingsCard>
          <SettingsRow
            label={skillPath || t('skills.noCustomPathSet')}
            description={t('skills.browseHint')}
            action={
              <button
                onClick={handleSelectSkillPath}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
              >
                <FolderIcon size={14} />
                {t('skills.browse')}
              </button>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Skills List */}
      <SettingsSection title={t('skills.availableSkills')} description={t('skills.skillCountPlural', { count: filteredSkills.length })}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12">
            <SpinnerGapIcon size={18} className="animate-spin" />
            <span className="text-sm text-muted-foreground">{t('skills.loading')}</span>
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-sm text-destructive mb-2">{error}</p>
            <button onClick={() => void loadSkills()} className="text-sm text-accent hover:underline">
              {t('skills.retry')}
            </button>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">
              {searchQuery ? t('skills.noSkillsFound', { query: searchQuery }) : t('skills.noSkillsAvailable')}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(groupedSkills).map(([category, categorySkills]) => (
              <div key={category}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  {category.charAt(0).toUpperCase() + category.slice(1)}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {categorySkills.map((skill) => (
                    <SkillCard
                      key={skill.name}
                      skill={skill}
                      isEnabled={true}
                      onClick={() => setSelectedSkill(skill)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Skill Detail Modal */}
      {selectedSkill && <SkillDetailModal skill={selectedSkill} onClose={() => setSelectedSkill(null)} />}
    </div>
  );
}
