"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { LightningIcon, SearchIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/icons";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { useTranslation } from "@/hooks/useTranslation";

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
}

interface SyncStatus {
  synced: boolean;
  added: string[];
  updated: string[];
  skipped: string[];
  removed: string[];
  error?: string;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  development: { bg: "rgba(59, 130, 246, 0.1)", text: "#3b82f6", border: "rgba(59, 130, 246, 0.3)" },
  research: { bg: "rgba(168, 85, 247, 0.1)", text: "#a855f7", border: "rgba(168, 85, 247, 0.3)" },
  creative: { bg: "rgba(236, 72, 153, 0.1)", text: "#ec4899", border: "rgba(236, 72, 153, 0.3)" },
  productivity: { bg: "rgba(34, 197, 94, 0.1)", text: "#22c55e", border: "rgba(34, 197, 94, 0.3)" },
  automation: { bg: "rgba(245, 158, 11, 0.1)", text: "#f59e0b", border: "rgba(245, 158, 11, 0.3)" },
  communication: { bg: "rgba(14, 165, 233, 0.1)", text: "#0ea5e9", border: "rgba(14, 165, 233, 0.3)" },
  media: { bg: "rgba(239, 68, 68, 0.1)", text: "#ef4444", border: "rgba(239, 68, 68, 0.3)" },
  mcp: { bg: "rgba(99, 102, 241, 0.1)", text: "#6366f1", border: "rgba(99, 102, 241, 0.3)" },
  system: { bg: "rgba(107, 114, 128, 0.1)", text: "#6b7280", border: "rgba(107, 114, 128, 0.3)" },
  other: { bg: "rgba(156, 163, 175, 0.1)", text: "#9ca3af", border: "rgba(156, 163, 175, 0.3)" },
};

function getCategoryColor(category?: string) {
  return CATEGORY_COLORS[category || "other"] || CATEGORY_COLORS.other;
}

function SkillCard({ skill, isExpanded, onToggle }: { skill: SkillWithContent; isExpanded: boolean; onToggle: () => void }) {
  const categoryColor = getCategoryColor(skill.category);

  return (
    <div className={`transition-all duration-200 ${isExpanded ? "md:col-span-2" : ""}`}>
      <div
        className={`surface-card cursor-pointer transition-all duration-200 hover:border-[var(--accent)] ${
          isExpanded ? "border-[var(--accent)]" : ""
        }`}
        onClick={onToggle}
        style={{ padding: "0.84rem 0.88rem" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
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
              {skill.source && (
                <span className="text-[0.7rem] text-[var(--muted)] capitalize">
                  {skill.source}
                </span>
              )}
            </div>
            <h3 className="text-[0.95rem] font-semibold text-[var(--text)] mb-1.5 leading-tight">
              {skill.name}
            </h3>
            <p className="text-[0.83rem] text-[var(--muted)] leading-[1.5] line-clamp-2">
              {skill.description}
            </p>
          </div>
          <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center text-xs font-medium" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>
            {isExpanded ? '−' : '+'}
          </div>
        </div>
      </div>

      {isExpanded && (
        <div
          className="mt-3 surface-card border-[var(--accent)]"
          style={{ animation: "fadeInSlideDown 0.2s ease-out" }}
        >
          <SkillDetail skill={skill} />
        </div>
      )}
    </div>
  );
}

function SkillDetail({ skill }: { skill: SkillWithContent }) {
  const { t } = useTranslation();
  const metadataFields = [
    { key: t('skills.category'), value: skill.category },
    { key: t('skills.source'), value: skill.source },
    { key: t('skills.userInvocable'), value: skill.userInvocable ? t('skills.yes') : t('skills.no') },
    { key: t('skills.whenToUse'), value: skill.whenToUse },
    { key: t('skills.platforms'), value: skill.platforms?.length ? skill.platforms.join(", ") : undefined },
  ].filter((f) => f.value);

  return (
    <div className="p-4">
      <div className="mb-4">
        <h4 className="text-[0.75rem] font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">
          {t('skills.metadata')}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          {metadataFields.map((field) => (
            <div key={field.key} className="bg-[var(--surface)] rounded-lg p-3">
              <span className="text-[0.7rem] text-[var(--muted)] block mb-1">{field.key}</span>
              <span className="text-[0.85rem] text-[var(--text)] capitalize">{String(field.value)}</span>
            </div>
          ))}
          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="bg-[var(--surface)] rounded-lg p-3 col-span-2">
              <span className="text-[0.7rem] text-[var(--muted)] block mb-2">{t('skills.allowedTools')}</span>
              <div className="flex flex-wrap gap-1.5">
                {skill.allowedTools.map((tool) => (
                  <span
                    key={tool}
                    className="text-[0.75rem] px-2 py-1 rounded-md bg-[var(--chip)] text-[var(--text)]"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {skill.content && (
        <div>
          <h4 className="text-[0.75rem] font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">
            {t('skills.documentation')}
          </h4>
          <MarkdownRenderer className="skill-markdown">
            {skill.content}
          </MarkdownRenderer>
        </div>
      )}
    </div>
  );
}

export function SkillsView() {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillWithContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const win = window as unknown as { electronAPI?: { skills?: { list: () => Promise<{ success: boolean; skills: SkillWithContent[]; error?: string; syncStatus?: SyncStatus | null }> } } };
      
      if (!win.electronAPI?.skills?.list) {
        setError("Skills API not available");
        setLoading(false);
        return;
      }

      const result = await win.electronAPI.skills.list();
      
      if (result.success) {
        setSkills(result.skills);
        setSyncStatus(result.syncStatus ?? null);
      } else {
        setError(result.error || "Failed to load skills");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, []);

  const handleRetrySync = useCallback(async () => {
    setSyncing(true);
    await loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const query = searchQuery.toLowerCase();
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query) ||
        skill.category?.toLowerCase().includes(query)
    );
  }, [searchQuery, skills]);

  const handleToggleSkill = (skillName: string) => {
    setExpandedSkill(expandedSkill === skillName ? null : skillName);
  };

  return (
    <div className="page skills-page">
      <div className="page-header">
        <div className="header-content">
          <div className="header-icon">
            <LightningIcon size={20} />
          </div>
          <div>
            <h1>{t('skills.title')}</h1>
            <p>{t('skills.description')}</p>
          </div>
        </div>
      </div>

      <div className="mb-5">
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">
            <SearchIcon size={18} />
          </div>
          <input
            type="text"
            placeholder={t('skills.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-xl py-2.5 pl-10 pr-4 text-[0.9rem] text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] transition-all"
          />
        </div>
      </div>

      {syncStatus && !syncStatus.synced && (
        <div className="mb-4 p-3 rounded-xl border border-[var(--warning-soft)] bg-[var(--warning-bg)] text-[var(--warning)] text-[0.85rem] flex items-center justify-between gap-3">
          <span>{t('skills.syncFailed')}{syncStatus.error ? `: ${syncStatus.error}` : ''}</span>
          <button
            onClick={() => void handleRetrySync()}
            disabled={syncing}
            className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-[var(--warning)] text-white text-[0.8rem] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {syncing ? t('skills.syncing') : t('skills.retrySync')}
          </button>
        </div>
      )}

      {syncStatus?.synced && (syncStatus.added.length > 0 || syncStatus.updated.length > 0) && (
        <div className="mb-4 p-3 rounded-xl border border-[var(--success-soft)] bg-[var(--success-bg)] text-[var(--success)] text-[0.85rem]">
          {syncStatus.added.length > 0 && (
            <p>{t('skills.syncAdded', { count: syncStatus.added.length, names: syncStatus.added.join(', ') })}</p>
          )}
          {syncStatus.updated.length > 0 && (
            <p>{t('skills.syncUpdated', { count: syncStatus.updated.length, names: syncStatus.updated.join(', ') })}</p>
          )}
        </div>
      )}

      {loading ? (
        <div className="empty-state py-12">
          <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[var(--muted)] text-[0.9rem]">{t('skills.loading')}</p>
        </div>
      ) : error ? (
        <div className="empty-state py-12">
          <p className="text-[var(--error)] text-[0.9rem] mb-2">{error}</p>
          <button
            onClick={() => void loadSkills()}
            className="text-[var(--accent)] text-[0.85rem] hover:underline"
          >
            {t('skills.retry')}
          </button>
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="empty-state py-12">
          <p className="text-[var(--muted)] text-[0.9rem]">
            {searchQuery ? t('skills.noSkillsFound', { query: searchQuery }) : t('skills.noSkillsAvailable')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-4">
          {filteredSkills.map((skill) => (
            <SkillCard
              key={skill.name}
              skill={skill}
              isExpanded={expandedSkill === skill.name}
              onToggle={() => handleToggleSkill(skill.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
