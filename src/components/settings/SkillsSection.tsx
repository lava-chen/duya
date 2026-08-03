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
  ArrowLeftIcon,
  EyeIcon,
  CodeIcon,
  InfoIcon,
  DotsThreeIcon,
  CaretDownIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
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
  enabled?: boolean;
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
  skillRoot?: string;
}

interface SkillFileNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  extension?: string;
  children?: SkillFileNode[];
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
    sm: "w-7 h-7 text-base rounded-lg",
    md: "w-9 h-9 text-lg rounded-xl",
    lg: "w-12 h-12 text-2xl rounded-xl",
  };

  return (
    <div
      className={`${sizeClasses[size]} flex items-center justify-center flex-shrink-0`}
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

  if (source === "bundled" || source === "builtin-directory") {
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

function SkillListItem({
  skill,
  isEnabled,
  onClick,
}: {
  skill: SkillWithContent;
  isEnabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-3 py-3 hover:bg-muted/40 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <SkillIcon category={skill.category} size="sm" />
      <div className="flex-1 min-w-0 flex items-center gap-4">
        <h3 className="text-sm font-semibold text-foreground leading-tight truncate shrink-0 max-w-[180px]">
          {skill.name}
        </h3>
        <p className="text-sm text-muted-foreground leading-tight truncate flex-1">{skill.description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <SecurityBadge security={skill.security} source={skill.source} />
        {isEnabled && (
          <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <CheckIcon size={12} className="text-emerald-500" />
          </div>
        )}
      </div>
    </div>
  );
}

function SkillDetailModal({
  skill,
  onClose,
  onToggleEnabled,
  isToggling,
}: {
  skill: SkillWithContent;
  onClose: () => void;
  onToggleEnabled: (skill: SkillWithContent) => void;
  isToggling: boolean;
}) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [bypassedSkills, setBypassedSkills] = useState<string[]>([]);
  const [isLoadingBypass, setIsLoadingBypass] = useState(false);

  // File viewer state
  const [activeFile, setActiveFile] = useState<string>("SKILL.md");
  const [fileTree, setFileTree] = useState<SkillFileNode[]>([]);
  const [fileContent, setFileContent] = useState<string>(skill.content);
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
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

  useEffect(() => {
    const skillRoot = skill.skillRoot;
    if (!skillRoot) return;

    const loadFiles = async () => {
      const win = window as unknown as {
        electronAPI?: { files?: { browse: (dir: string) => Promise<{ success: boolean; tree: SkillFileNode[] }> } };
      };
      if (!win.electronAPI?.files?.browse) return;
      const result = await win.electronAPI.files.browse(skillRoot);
      if (result.success) {
        setFileTree(result.tree);
      }
    };

    setActiveFile("SKILL.md");
    setViewMode("preview");
    setFileContent(skill.content);
    void loadFiles();
  }, [skill.skillRoot, skill.name, skill.content]);

  useEffect(() => {
    const skillRoot = skill.skillRoot;
    if (!skillRoot) return;

    if (activeFile === "SKILL.md") {
      setFileContent(skill.content);
      return;
    }

    const loadContent = async () => {
      setLoadingFile(true);
      const win = window as unknown as {
        electronAPI?: {
          files?: {
            preview: (
              targetPath: string,
              rootPath: string,
            ) => Promise<{ success: boolean; content?: string; kind?: string; error?: string }>;
          };
        };
      };
      if (!win.electronAPI?.files?.preview) {
        setLoadingFile(false);
        return;
      }
      const targetPath = `${skillRoot}/${activeFile}`;
      const result = await win.electronAPI.files.preview(targetPath, skillRoot);
      if (result.success && typeof result.content === "string") {
        setFileContent(result.content);
      } else {
        setFileContent(result.error || "Failed to load file");
      }
      setLoadingFile(false);
    };

    void loadContent();
  }, [activeFile, skill.skillRoot, skill.content]);

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

  const allFiles = useMemo(() => {
    const files: { name: string; path: string }[] = [];
    const walk = (nodes: SkillFileNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") files.push({ name: node.name, path: node.path });
        if (node.children) walk(node.children);
      }
    };
    walk(fileTree);
    return files;
  }, [fileTree]);

  const fileCount = useMemo(() => allFiles.length, [allFiles]);

  const isBypassed = bypassedSkills.includes(skill.name);
  const isEnabled = skill.enabled !== false;
  const author = (skill.frontmatter?.author as string | undefined) || undefined;

  const description = skill.description || "";
  const DESCRIPTION_TRUNCATE_AT = 180;
  const shouldTruncate = description.length > DESCRIPTION_TRUNCATE_AT;
  const displayedDescription = descriptionExpanded
    ? description
    : `${description.slice(0, DESCRIPTION_TRUNCATE_AT)}${shouldTruncate ? "..." : ""}`;

  const securityStatus = useMemo(() => {
    if (!skill.security?.scanned) return null;
    if (skill.source === "bundled" || skill.source === "builtin-directory") {
      return { label: t("skills.trustedBuiltin"), variant: "safe" as const };
    }
    if (skill.security.verdict === "dangerous") {
      return { label: t("skills.blocked"), variant: "dangerous" as const };
    }
    if (skill.security.verdict === "caution") {
      return { label: t("skills.caution"), variant: "caution" as const };
    }
    return { label: t("skills.safe"), variant: "safe" as const };
  }, [skill.security, skill.source, t]);

  const activeFileName = allFiles.find((f) => f.path === activeFile)?.name || activeFile;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" ref={modalRef}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl max-h-[90vh] bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] transition-colors"
          >
            <ArrowLeftIcon size={18} />
            <span>{t("skills.title")}</span>
          </button>
          <IconButton variant="ghost" size="md" aria-label="Close" onClick={onClose}>
            <XIcon size={20} />
          </IconButton>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-5">
            {/* Title row */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-xl font-semibold text-foreground">{skill.name}</h2>
                  <InfoIcon size={18} className="text-muted-foreground shrink-0" />
                </div>
                {author && <p className="text-sm text-muted-foreground">by {author}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  onClick={() => onToggleEnabled(skill)}
                  disabled={isToggling}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--main-bg)] disabled:opacity-60 ${
                    isEnabled ? "bg-[var(--success)]" : "bg-[var(--muted)]"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      isEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <IconButton variant="ghost" size="md" aria-label="More options">
                  <DotsThreeIcon size={20} />
                </IconButton>
              </div>
            </div>

            {/* Description */}
            <div>
              <p className="text-sm text-muted-foreground leading-relaxed inline">{displayedDescription}</p>
              {shouldTruncate && (
                <button
                  type="button"
                  onClick={() => setDescriptionExpanded((v) => !v)}
                  className="text-sm text-[var(--accent)] hover:underline ml-1"
                >
                  {descriptionExpanded ? "See less" : "See more"}
                </button>
              )}
            </div>

            {/* Security status */}
            {securityStatus && (
              <div className="flex items-center gap-2">
                {securityStatus.variant === "safe" ? (
                  <ShieldIcon size={16} className="text-emerald-500" />
                ) : securityStatus.variant === "dangerous" ? (
                  <ProhibitIcon size={16} className="text-red-500" />
                ) : (
                  <WarningIcon size={16} className="text-amber-500" />
                )}
                <span
                  className={`text-xs font-medium ${
                    securityStatus.variant === "safe"
                      ? "text-emerald-500"
                      : securityStatus.variant === "dangerous"
                      ? "text-red-500"
                      : "text-amber-500"
                  }`}
                >
                  {securityStatus.label}
                </span>
                {skill.security && skill.security.findings.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    ({skill.security.findings.length} {t("skills.securityFindings", { count: skill.security.findings.length })})
                  </span>
                )}
              </div>
            )}

            {/* Bypass action for non-safe user skills */}
            {skill.security?.scanned &&
              skill.source !== "bundled" &&
              skill.source !== "builtin-directory" &&
              skill.security.verdict !== "safe" && (
                <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
                  <p className="text-xs text-muted-foreground flex-1">{t("skills.skillBlocked")}</p>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleToggleBypass}
                    disabled={isLoadingBypass}
                    className={`shrink-0 ${
                      isBypassed
                        ? "bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border-yellow-500/30"
                        : ""
                    }`}
                  >
                    {isLoadingBypass
                      ? t("skills.updating")
                      : isBypassed
                      ? t("skills.removeBypass")
                      : t("skills.bypassSecurity")}
                  </Button>
                </div>
              )}
            {isBypassed && (
              <p className="text-xs text-yellow-500">{t("skills.bypassedWarning")}</p>
            )}

            {/* File viewer panel */}
            <div className="rounded-xl border border-border/50 bg-muted/20 overflow-hidden">
              {/* Panel header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="relative" ref={dropdownRef}>
                    <button
                      type="button"
                      onClick={() => setDropdownOpen((v) => !v)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border/50 text-sm text-foreground hover:bg-muted/40 transition-colors"
                    >
                      <span className="truncate max-w-[160px]">{activeFileName}</span>
                      <CaretDownIcon
                        size={14}
                        className={`text-muted-foreground transition-transform shrink-0 ${dropdownOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {dropdownOpen && (
                      <div className="absolute top-full left-0 mt-1 min-w-[180px] max-h-60 overflow-y-auto rounded-lg border border-border/50 bg-[var(--main-bg)] shadow-lg z-20">
                        {allFiles.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            onClick={() => {
                              setActiveFile(file.path);
                              setDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/40 transition-colors ${
                              file.path === activeFile ? "bg-muted/50 text-foreground" : "text-muted-foreground"
                            }`}
                          >
                            {file.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{fileCount} files</span>
                </div>
                <div className="flex items-center rounded-lg border border-border/50 bg-surface p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode("preview")}
                    className={`p-1.5 rounded-md transition-colors ${
                      viewMode === "preview"
                        ? "bg-muted/60 text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    aria-label="Preview"
                  >
                    <EyeIcon size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("code")}
                    className={`p-1.5 rounded-md transition-colors ${
                      viewMode === "code"
                        ? "bg-muted/60 text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    aria-label="Code"
                  >
                    <CodeIcon size={16} />
                  </button>
                </div>
              </div>

              {/* Panel content */}
              <div className="p-4 min-h-[300px] max-h-[60vh] overflow-y-auto">
                {loadingFile ? (
                  <div className="flex items-center justify-center py-12">
                    <SpinnerGapIcon size={20} className="animate-spin text-muted-foreground" />
                  </div>
                ) : viewMode === "code" ? (
                  <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">{fileContent}</pre>
                ) : (
                  <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none">
                    {fileContent}
                  </MarkdownRenderer>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkillsSection() {
  const { t } = useTranslation();
  const [skillPath, setSkillPath] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillWithContent | null>(null);
  const [skills, setSkills] = useState<SkillWithContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingSkillName, setTogglingSkillName] = useState<string | null>(null);

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
          skills?: {
            list: () => Promise<{ success: boolean; skills: SkillWithContent[]; error?: string }>;
            setEnabled: (skillName: string, enabled: boolean) => Promise<{ success: boolean; overrides?: Record<string, boolean>; error?: string }>;
          };
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

  const handleToggleEnabled = useCallback(async (skill: SkillWithContent) => {
    const win = window as unknown as {
      electronAPI?: {
        skills?: {
          setEnabled: (skillName: string, enabled: boolean) => Promise<{ success: boolean; overrides?: Record<string, boolean>; error?: string }>;
        };
      };
    };
    if (!win.electronAPI?.skills?.setEnabled) return;

    const nextEnabled = skill.enabled === false;
    setTogglingSkillName(skill.name);
    const result = await win.electronAPI.skills.setEnabled(skill.name, nextEnabled);
    setTogglingSkillName(null);

    if (!result.success) {
      setError(result.error || "Failed to update skill state");
      return;
    }

    setSkills((prev) => prev.map((item) => item.name === skill.name ? { ...item, enabled: nextEnabled } : item));
    setSelectedSkill((prev) => prev && prev.name === skill.name ? { ...prev, enabled: nextEnabled } : prev);
  }, []);

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
        <div className="mb-6">
          <Input
            type="search"
            placeholder={t('skills.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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
              <Button
                variant="primary"
                size="sm"
                onClick={handleSelectSkillPath}
              >
                <FolderIcon size={14} />
                {t('skills.browse')}
              </Button>
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
            <Button variant="ghost" size="sm" onClick={() => void loadSkills()}>
              {t('skills.retry')}
            </Button>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">
              {searchQuery ? t('skills.noSkillsFound', { query: searchQuery }) : t('skills.noSkillsAvailable')}
            </p>
          </div>
        ) : (
          <SettingsCard className="divide-y divide-border/20">
            {filteredSkills.map((skill) => (
              <SkillListItem
                key={skill.name}
                skill={skill}
                isEnabled={skill.enabled !== false}
                onClick={() => setSelectedSkill(skill)}
              />
            ))}
          </SettingsCard>
        )}
      </SettingsSection>

      {/* Skill Detail Modal */}
      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onToggleEnabled={handleToggleEnabled}
          isToggling={togglingSkillName === selectedSkill.name}
        />
      )}
    </div>
  );
}
