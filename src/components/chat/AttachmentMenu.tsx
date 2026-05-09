// AttachmentMenu.tsx - Plus button dropdown menu for attachments, skills, MCP, and styles

'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  PaperclipIcon,
  WrenchIcon,
  PlugIcon,
  FeatherIcon,
  BrainIcon,
  CaretRightIcon,
  PlusIcon,
  CheckIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';

interface Skill {
  name: string;
  description?: string;
  source?: string;
}

interface McpServer {
  name: string;
  description?: string;
  enabled?: boolean;
}

interface ResponseStyle {
  id: string;
  name: string;
  description?: string;
  icon?: React.ReactNode;
}

interface AttachmentMenuProps {
  onAddFiles: () => void;
  skills: Skill[];
  mcpServers: McpServer[];
  responseStyles: ResponseStyle[];
  selectedStyle: string | null;
  onSelectStyle: (styleId: string) => void;
  onSelectSkill: (skillName: string) => void;
  onToggleMcpServer: (serverName: string, enabled: boolean) => void;
  onManageSkills?: () => void;
  onAddSkill?: () => void;
  onCreateStyle?: () => void;
  // Thinking effort props
  thinkingEffort: string | null;
  onSelectThinkingEffort: (effort: string | null) => void;
  modelSupportsEffort?: boolean;
}

type SubMenuType = 'skills' | 'mcp' | 'styles' | 'thinking' | null;

interface ThinkingEffortOption {
  value: string | null;
  label: string;
  description: string;
}

const THINKING_EFFORT_OPTIONS: ThinkingEffortOption[] = [
  { value: null, label: 'Auto', description: 'Default thinking level' },
  { value: 'low', label: 'Low', description: 'Quick responses' },
  { value: 'medium', label: 'Medium', description: 'Balanced approach' },
  { value: 'high', label: 'High', description: 'Deep reasoning' },
  { value: 'max', label: 'Max', description: 'Maximum capability' },
];

export function AttachmentMenu({
  onAddFiles,
  skills,
  mcpServers,
  responseStyles,
  selectedStyle,
  onSelectStyle,
  onSelectSkill,
  onToggleMcpServer,
  onManageSkills,
  onAddSkill,
  onCreateStyle,
  thinkingEffort,
  onSelectThinkingEffort,
  modelSupportsEffort = true,
}: AttachmentMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredSubmenu, setHoveredSubmenu] = useState<SubMenuType>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setHoveredSubmenu(null);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Close menu on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setHoveredSubmenu(null);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
    if (isOpen) {
      setHoveredSubmenu(null);
    }
  }, [isOpen]);

  const handleAddFiles = useCallback(() => {
    onAddFiles();
    setIsOpen(false);
    setHoveredSubmenu(null);
  }, [onAddFiles]);

  const handleSubmenuEnter = (submenu: SubMenuType) => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
    setHoveredSubmenu(submenu);
  };

  const handleSubmenuLeave = () => {
    submenuTimeoutRef.current = setTimeout(() => {
      setHoveredSubmenu(null);
    }, 150);
  };

  const handleSelectSkill = (skillName: string) => {
    onSelectSkill(skillName);
    setIsOpen(false);
    setHoveredSubmenu(null);
  };

  const handleSelectStyle = (styleId: string) => {
    onSelectStyle(styleId);
    setIsOpen(false);
    setHoveredSubmenu(null);
  };

  const handleSelectThinkingEffort = (effort: string | null) => {
    onSelectThinkingEffort(effort);
    setIsOpen(false);
    setHoveredSubmenu(null);
  };

  const getSelectedEffortLabel = () => {
    const option = THINKING_EFFORT_OPTIONS.find(opt => opt.value === thinkingEffort);
    return option?.label || 'Auto';
  };

  // Menu item positions for submenu positioning
  const getSubmenuPosition = (submenu: SubMenuType) => {
    switch (submenu) {
      case 'skills':
        return { bottom: 'auto', top: '28px' };
      case 'mcp':
        return { bottom: 'auto', top: '56px' };
      case 'thinking':
        return { bottom: '28px', top: 'auto' };
      case 'styles':
        return { bottom: '0px', top: 'auto' };
      default:
        return { bottom: 'auto', top: '0px' };
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Plus Button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200 bg-transparent hover:bg-muted"
        title={t('attachmentMenu.attach') || 'Attach'}
      >
        <PlusIcon size={14} />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          {/* Main Menu Panel */}
          <div
            className="absolute bottom-full left-0 mb-2 w-56 rounded-xl shadow-lg border py-1.5 z-[100]"
            style={{
              backgroundColor: 'var(--main-bg)',
              borderColor: 'var(--border)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            }}
          >
            {/* Add files */}
            <button
              type="button"
              onClick={handleAddFiles}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-white/5"
            >
              <span style={{ color: 'var(--muted)' }}>
                <PaperclipIcon size={16} />
              </span>
              <span style={{ color: 'var(--foreground)' }}>
                {t('attachmentMenu.addFilesOrPhotos') || 'Add files or photos'}
              </span>
            </button>

            {/* Skills with hover submenu trigger */}
            <div
              className="relative"
              onMouseEnter={() => handleSubmenuEnter('skills')}
              onMouseLeave={handleSubmenuLeave}
            >
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-white/5"
              >
                <div className="flex items-center gap-3">
                  <span style={{ color: 'var(--muted)' }}>
                    <WrenchIcon size={16} />
                  </span>
                  <span style={{ color: 'var(--foreground)' }}>
                    {t('attachmentMenu.skills') || 'Skills'}
                  </span>
                </div>
                <CaretRightIcon size={14} style={{ color: 'var(--muted)' }} />
              </button>
            </div>

            {/* MCP with hover submenu trigger */}
            <div
              className="relative"
              onMouseEnter={() => handleSubmenuEnter('mcp')}
              onMouseLeave={handleSubmenuLeave}
            >
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-white/5"
              >
                <div className="flex items-center gap-3">
                  <span style={{ color: 'var(--muted)' }}>
                    <PlugIcon size={16} />
                  </span>
                  <span style={{ color: 'var(--foreground)' }}>
                    {t('attachmentMenu.mcp') || 'MCP'}
                  </span>
                </div>
                <CaretRightIcon size={14} style={{ color: 'var(--muted)' }} />
              </button>
            </div>

            {/* Thinking Effort with hover submenu trigger */}
            {modelSupportsEffort && (
              <div
                className="relative"
                onMouseEnter={() => handleSubmenuEnter('thinking')}
                onMouseLeave={handleSubmenuLeave}
              >
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-white/5"
                >
                  <div className="flex items-center gap-3">
                    <span style={{ color: 'var(--muted)' }}>
                      <BrainIcon size={16} />
                    </span>
                    <span style={{ color: 'var(--foreground)' }}>
                      {t('attachmentMenu.thinkingEffort') || 'Thinking'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {getSelectedEffortLabel()}
                    </span>
                    <CaretRightIcon size={14} style={{ color: 'var(--muted)' }} />
                  </div>
                </button>
              </div>
            )}

            {/* Styles with hover submenu trigger */}
            <div
              className="relative"
              onMouseEnter={() => handleSubmenuEnter('styles')}
              onMouseLeave={handleSubmenuLeave}
            >
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-white/5"
              >
                <div className="flex items-center gap-3">
                  <span style={{ color: 'var(--muted)' }}>
                    <FeatherIcon size={16} />
                  </span>
                  <span style={{ color: 'var(--foreground)' }}>
                    {t('attachmentMenu.useStyle') || 'Use style'}
                  </span>
                </div>
                <CaretRightIcon size={14} style={{ color: 'var(--muted)' }} />
              </button>
            </div>
          </div>

          {/* Skills Submenu - appears to the right of main menu, bottom aligned */}
          {hoveredSubmenu === 'skills' && (
            <div
              className="absolute w-56 rounded-xl shadow-lg border py-1.5 z-[101]"
              style={{
                backgroundColor: 'var(--main-bg)',
                borderColor: 'var(--border)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                left: '224px', // 56 * 4 = 224px (w-56 = 14rem = 224px)
                bottom: '8px', // align with bottom of main menu to avoid overflow
                marginBottom: '8px',
              }}
              onMouseEnter={() => handleSubmenuEnter('skills')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div className="max-h-48 overflow-y-auto">
                {skills.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-center" style={{ color: 'var(--muted)' }}>
                    {t('attachmentMenu.noSkills') || 'No skills available'}
                  </div>
                ) : (
                  skills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => handleSelectSkill(skill.name)}
                      className="w-full px-3 py-2 text-left transition-colors hover:bg-white/5"
                    >
                      <div className="text-sm" style={{ color: 'var(--foreground)' }}>
                        {skill.name}
                      </div>
                      {skill.description && (
                        <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                          {skill.description}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>

              {/* Footer Actions */}
              <div className="border-t mt-1 pt-1" style={{ borderColor: 'var(--border)' }}>
                {onManageSkills && (
                  <button
                    type="button"
                    onClick={() => {
                      onManageSkills();
                      setIsOpen(false);
                      setHoveredSubmenu(null);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-white/5"
                  >
                    <WrenchIcon size={14} style={{ color: 'var(--muted)' }} />
                    <span style={{ color: 'var(--foreground)' }}>
                      {t('attachmentMenu.manageSkills') || 'Manage skills'}
                    </span>
                  </button>
                )}
                {onAddSkill && (
                  <button
                    type="button"
                    onClick={() => {
                      onAddSkill();
                      setIsOpen(false);
                      setHoveredSubmenu(null);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-white/5"
                  >
                    <PlusIcon size={14} style={{ color: 'var(--muted)' }} />
                    <span style={{ color: 'var(--foreground)' }}>
                      {t('attachmentMenu.addSkill') || 'Add skill'}
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* MCP Submenu - appears to the right of main menu, bottom aligned */}
          {hoveredSubmenu === 'mcp' && (
            <div
              className="absolute w-56 rounded-xl shadow-lg border py-1.5 z-[101]"
              style={{
                backgroundColor: 'var(--main-bg)',
                borderColor: 'var(--border)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                left: '224px', // 56 * 4 = 224px (w-56 = 14rem = 224px)
                bottom: '8px', // align with bottom of main menu to avoid overflow
                marginBottom: '8px',
              }}
              onMouseEnter={() => handleSubmenuEnter('mcp')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div className="max-h-48 overflow-y-auto">
                {mcpServers.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-center" style={{ color: 'var(--muted)' }}>
                    {t('attachmentMenu.noMcpServers') || 'No MCP servers configured'}
                  </div>
                ) : (
                  mcpServers.map((server) => (
                    <div
                      key={server.name}
                      className="flex items-center justify-between px-3 py-2 hover:bg-white/5"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm" style={{ color: 'var(--foreground)' }}>
                          {server.name}
                        </div>
                        {server.description && (
                          <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                            {server.description}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => onToggleMcpServer(server.name, !server.enabled)}
                        className={cn(
                          'w-8 h-4 rounded-full transition-colors relative shrink-0 ml-2',
                          server.enabled ? 'bg-accent' : 'bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform',
                            server.enabled ? 'translate-x-4' : 'translate-x-0.5'
                          )}
                        />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Thinking Effort Submenu - appears to the right of main menu, bottom aligned */}
          {hoveredSubmenu === 'thinking' && (
            <div
              className="absolute w-56 rounded-xl shadow-lg border py-1.5 z-[101]"
              style={{
                backgroundColor: 'var(--main-bg)',
                borderColor: 'var(--border)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                left: '224px', // 56 * 4 = 224px (w-56 = 14rem = 224px)
                bottom: '8px', // align with bottom of main menu to avoid overflow
                marginBottom: '8px',
              }}
              onMouseEnter={() => handleSubmenuEnter('thinking')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div className="max-h-48 overflow-y-auto">
                {THINKING_EFFORT_OPTIONS.map((option) => (
                  <button
                    key={option.value || 'auto'}
                    type="button"
                    onClick={() => handleSelectThinkingEffort(option.value)}
                    className="w-full flex items-center gap-3 px-3 py-2 transition-colors hover:bg-white/5"
                  >
                    <div className="flex-1 text-left">
                      <div
                        className={cn(
                          'text-sm',
                          thinkingEffort === option.value && 'font-medium'
                        )}
                        style={{
                          color: thinkingEffort === option.value ? 'var(--accent)' : 'var(--foreground)',
                        }}
                      >
                        {option.label}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                        {option.description}
                      </div>
                    </div>
                    {thinkingEffort === option.value && (
                      <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Styles Submenu - appears to the right of main menu, bottom aligned */}
          {hoveredSubmenu === 'styles' && (
            <div
              className="absolute w-56 rounded-xl shadow-lg border py-1.5 z-[101]"
              style={{
                backgroundColor: 'var(--main-bg)',
                borderColor: 'var(--border)',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
                left: '224px', // 56 * 4 = 224px (w-56 = 14rem = 224px)
                bottom: '8px', // align with bottom of main menu to avoid overflow
                marginBottom: '8px',
              }}
              onMouseEnter={() => handleSubmenuEnter('styles')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div className="max-h-48 overflow-y-auto">
                {responseStyles.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-center" style={{ color: 'var(--muted)' }}>
                    {t('attachmentMenu.noStyles') || 'No styles available'}
                  </div>
                ) : (
                  responseStyles.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => handleSelectStyle(style.id)}
                      className="w-full flex items-center gap-3 px-3 py-2 transition-colors hover:bg-white/5"
                    >
                      {style.icon && (
                        <span style={{ color: 'var(--muted)' }}>{style.icon}</span>
                      )}
                      <div className="flex-1 text-left">
                        <div
                          className={cn(
                            'text-sm',
                            selectedStyle === style.id && 'font-medium'
                          )}
                          style={{
                            color: selectedStyle === style.id ? 'var(--accent)' : 'var(--foreground)',
                          }}
                        >
                          {style.name}
                        </div>
                        {style.description && (
                          <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                            {style.description}
                          </div>
                        )}
                      </div>
                      {selectedStyle === style.id && (
                        <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                      )}
                    </button>
                  ))
                )}
              </div>

              {/* Footer Actions */}
              {onCreateStyle && (
                <div className="border-t mt-1 pt-1" style={{ borderColor: 'var(--border)' }}>
                  <button
                    type="button"
                    onClick={() => {
                      onCreateStyle();
                      setIsOpen(false);
                      setHoveredSubmenu(null);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-white/5"
                  >
                    <PlusIcon size={14} style={{ color: 'var(--muted)' }} />
                    <span style={{ color: 'var(--foreground)' }}>
                      {t('attachmentMenu.createStyle') || 'Create & edit styles'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
