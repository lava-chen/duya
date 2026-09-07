"use client";

/**
 * Sidebar.tsx — pixel-faithful static replica of the real DUYA left rail.
 *
 * Mirrors `AppSidebar` closely: a "工作 / Bots" segmented top (with create +
 * search), a body that switches between the Work primary-nav + thread list
 * and the Bots grouped contact list, and the `.sidebar-bottom` footer with
 * 扩展 / 设置 / theme-toggle.
 */

import { useState } from "react";
import { useTheme } from "next-themes";
import {
  BOTS,
  SIDEBAR_GROUPS,
  WORK_SESSIONS,
  type BotContact,
} from "./mock-data";

export interface SidebarProps {
  activeId: string;
  onSelect: (id: string) => void;
}

type SidebarTab = "work" | "bots";

/* ---- small stroke icons (no external dep) ---- */

function PlusIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="20" strokeLinecap="round">
      <path d="M200 128 H56" />
      <path d="M128 56 V200" />
    </svg>
  );
}

function SearchIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="116" cy="116" r="84" />
      <line x1="175" y1="175" x2="224" y2="224" />
    </svg>
  );
}

function CaretDownIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round">
      <path d="M208 96l-80 80-80-80" />
    </svg>
  );
}

function LayoutIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <rect x="40" y="40" width="176" height="176" rx="12" />
      <line x1="96" y1="40" x2="96" y2="216" />
      <line x1="40" y1="104" x2="216" y2="104" />
    </svg>
  );
}

function HashIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <line x1="104" y1="48" x2="72" y2="208" />
      <line x1="184" y1="48" x2="152" y2="208" />
      <line x1="48" y1="104" x2="208" y2="104" />
      <line x1="40" y1="160" x2="208" y2="160" />
    </svg>
  );
}

function ZapIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <path d="M144 32 L56 144 H124 L112 224 L200 112 H132 Z" />
    </svg>
  );
}

function PlugIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <path d="M96 64 V32 M160 64 V32" />
      <rect x="80" y="64" width="96" height="64" rx="12" />
      <path d="M128 128 V176" />
    </svg>
  );
}

function GearIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="128" cy="128" r="40" />
      <path d="M128 32 v32 M128 192 v32 M42 64 l28 16 M186 176 l28 16 M42 192 l28 -16 M186 80 l28 -16" />
    </svg>
  );
}

function SunIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="128" cy="128" r="40" />
      <line x1="128" y1="24" x2="128" y2="48" />
      <line x1="128" y1="208" x2="128" y2="232" />
      <line x1="24" y1="128" x2="48" y2="128" />
      <line x1="208" y1="128" x2="232" y2="128" />
      <line x1="55" y1="55" x2="72" y2="72" />
      <line x1="184" y1="184" x2="201" y2="201" />
      <line x1="55" y1="201" x2="72" y2="184" />
      <line x1="184" y1="72" x2="201" y2="55" />
    </svg>
  );
}

function MoonIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
      <path d="M200 152 a72 72 0 1 0 -96 -96 a80 80 0 0 0 96 96 Z" />
    </svg>
  );
}

/* ---- building blocks ---- */

function BotRow({
  contact,
  isActive,
  onOpen,
}: {
  contact: BotContact;
  isActive: boolean;
  onOpen: (contact: BotContact) => void;
}) {
  const running = contact.status === "running";
  const queued = contact.status === "queued";

  return (
    <div
      className={`bot-contact-item${isActive ? " active" : ""}`}
      onClick={() => onOpen(contact)}
      title={contact.subtitle || contact.name}
      role="button"
      tabIndex={0}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(contact);
        }
      }}
    >
      <span className="bot-contact-avatar-wrap">
        <span
          className="bot-contact-avatar"
          style={{
            backgroundColor: contact.color,
            width: 38,
            height: 38,
            fontSize: Math.round(38 * 0.63),
          }}
          aria-hidden="true"
        >
          <span className="bot-contact-avatar-glyph">{contact.emoji}</span>
        </span>
        {running ? (
          <span className="bot-contact-running-ring" title="运行中" aria-label="运行中" />
        ) : null}
      </span>
      <span className="bot-contact-body">
        <span className="bot-contact-head">
          <span className="bot-contact-name">{contact.name}</span>
          <span className="bot-contact-trailing">
            {queued ? (
              <span className="bot-contact-status-pill queued" title="排队中">
                排队中
              </span>
            ) : (
              <span className="bot-contact-time">{contact.lastTime}</span>
            )}
          </span>
        </span>
        <span className="bot-contact-preview" title={contact.subtitle}>
          {contact.subtitle}
        </span>
      </span>
    </div>
  );
}

export default function Sidebar({ activeId, onSelect }: SidebarProps) {
  const [tab, setTab] = useState<SidebarTab>("bots");
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const botById = (id: string) => BOTS.find((b) => b.id === id);

  const mainNavItems: { view: string; label: string; icon: React.ComponentType<{ size: number }> }[] = [
    { view: "canvas", label: "画布", icon: LayoutIcon },
    { view: "channels", label: "频道", icon: HashIcon },
    { view: "automation", label: "自动化", icon: ZapIcon },
    { view: "extensions", label: "扩展", icon: PlugIcon },
  ];

  return (
    <aside className="app-sidebar">
      <div className="sidebar-top">
        <div className="sidebar-top-tabs" role="tablist" aria-label="Bots">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "work"}
            className={`sidebar-tab${tab === "work" ? " active" : ""}`}
            onClick={() => setTab("work")}
          >
            工作
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bots"}
            className={`sidebar-tab${tab === "bots" ? " active" : ""}`}
            onClick={() => setTab("bots")}
          >
            Bots
          </button>
          <div className="sidebar-top-create">
            <button
              type="button"
              className="sidebar-top-create-btn"
              aria-label="新建"
              title="新建"
              onClick={() => {}}
            >
              <PlusIcon size={15} />
            </button>
          </div>
          <button
            type="button"
            className="sidebar-top-search-btn"
            aria-label="搜索"
            title="搜索"
            onClick={() => {}}
          >
            <SearchIcon size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {tab === "work" ? (
          <>
            <nav className="sidebar-primary-nav" aria-label="Primary Navigation">
              <button type="button" className="sidebar-primary-link" onClick={() => {}}>
                <span className="nav-icon">
                  <PlusIcon size={16} />
                </span>
                <span>新对话</span>
              </button>
              {mainNavItems.map((item) => (
                <button key={item.view} type="button" className="sidebar-primary-link" onClick={() => {}}>
                  <span className="nav-icon">
                    <item.icon size={16} />
                  </span>
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>

            <div className="sidebar-section-group">
              <button
                type="button"
                className="sidebar-section-group-header"
                aria-expanded="true"
                onClick={() => {}}
              >
                <span className="sidebar-section-group-name">最近会话</span>
                <CaretDownIcon size={14} className="sidebar-section-group-caret" />
              </button>
              <div className="sidebar-section-group-body">
                {WORK_SESSIONS.map((session) => (
                  <BotRow
                    key={session.id}
                    contact={session}
                    isActive={session.id === activeId}
                    onOpen={(c) => onSelect(c.id)}
                  />
                ))}
              </div>
            </div>
          </>
        ) : (
          SIDEBAR_GROUPS.map((group) => (
            <div key={group.id} className="sidebar-section-group">
              <button
                type="button"
                className="sidebar-section-group-header"
                aria-expanded="true"
                onClick={() => {}}
              >
                <span className="sidebar-section-group-name">{group.label}</span>
                <CaretDownIcon size={14} className="sidebar-section-group-caret" />
              </button>
              <div className="sidebar-section-group-body">
                {group.items
                  .map((item) => botById(item.botId))
                  .filter((c): c is BotContact => Boolean(c))
                  .map((contact) => (
                    <BotRow
                      key={contact.id}
                      contact={contact}
                      isActive={contact.id === activeId}
                      onOpen={(c) => onSelect(c.id)}
                    />
                  ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/*
       * Real .sidebar-bottom layout:
       *   <div class="sidebar-bottom">          ← flex column, gap:0.25rem, padding:0 0.5rem
       *     <button class="sidebar-settings">扩展</button>   ← flex:1, own padding
       *     <div class="sidebar-bottom-row">       ← (optional row for settings+theme)
       *       <button class="sidebar-settings">设置</button>  ← flex:1
       *       <button class="theme-toggle" />               ← fixed 1.75rem square
       *     </div>
       *   </div>
       */}
      <div className="sidebar-bottom">
        <button type="button" className="sidebar-settings" onClick={() => {}}>
          <span className="nav-icon">
            <PlugIcon size={16} />
          </span>
          <span>扩展</span>
        </button>

        <div className="sidebar-bottom-row">
          <button type="button" className="sidebar-settings" onClick={() => {}}>
            <span className="nav-icon">
              <GearIcon size={16} />
            </span>
            <span>设置</span>
          </button>

          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme(dark ? "light" : "dark")}
            aria-label="切换主题"
          >
            {dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        </div>
      </div>
    </aside>
  );
}