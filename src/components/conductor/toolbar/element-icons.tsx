import type { ReactNode } from "react";

const iconStyle = {
  width: "100%",
  height: "100%",
  color: "currentColor",
} as const;

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const ELEMENT_ICONS: Record<
  "sticky" | "card" | "connector" | "mindmap" | "frame" | "section" | "text" | "shape" | "select",
  ReactNode
> = {
  sticky: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <path d="M6.5 4.5h8.8l3.2 3.2v11.8h-12z" fill="currentColor" fillOpacity="0.13" {...stroke} />
      <path d="M15.3 4.5v3.2h3.2" fill="currentColor" fillOpacity="0.21" {...stroke} />
      <path d="M9 11h6M9 14h5" {...stroke} />
    </svg>
  ),

  card: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="4.5" y="5" width="15" height="14" rx="3" {...stroke} />
      <path d="M7.5 9h7M7.5 13h9M7.5 16h5" {...stroke} opacity="0.75" />
    </svg>
  ),

  connector: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <circle cx="6.25" cy="16.75" r="2" fill="currentColor" fillOpacity="0.2" />
      <circle cx="17.75" cy="7.25" r="2" fill="currentColor" fillOpacity="0.2" />
      <path d="M8.4 15.9C12 14.9 12 9.2 15.7 8.1" {...stroke} />
      <path d="M14.9 5.8 18.3 7.2l-1.4 3.4" {...stroke} />
    </svg>
  ),

  mindmap: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="4" y="9" width="7" height="6" rx="2.1" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <path d="M11 12h3.8M14.8 7.8v8.2" {...stroke} />
      <rect x="15" y="5" width="5" height="4" rx="1.6" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <rect x="15" y="15" width="5" height="4" rx="1.6" fill="currentColor" fillOpacity="0.14" {...stroke} />
    </svg>
  ),

  frame: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="4.5" y="5" width="15" height="14" rx="2.6" {...stroke} strokeDasharray="3 2.4" />
      <path d="M7.5 8.8h5" {...stroke} />
      <rect x="7.5" y="12" width="4" height="3" rx="1" fill="currentColor" fillOpacity="0.24" />
      <rect x="12.8" y="12" width="3.7" height="3" rx="1" fill="currentColor" fillOpacity="0.24" />
    </svg>
  ),

  section: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="4.5" y="6" width="15" height="13" rx="2.6" fill="currentColor" fillOpacity="0.12" {...stroke} />
      <path d="M7.5 9.2h5M7.5 13h8.8" {...stroke} opacity="0.75" />
    </svg>
  ),

  text: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <path d="M5.5 6.5h13M12 6.5v11M9.2 17.5h5.6" {...stroke} />
    </svg>
  ),

  shape: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <rect x="4.5" y="5.2" width="6.6" height="6.3" rx="1.8" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <circle cx="16.7" cy="8.4" r="3.3" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <path d="M7.8 14.8 11.2 20H4.4z" fill="currentColor" fillOpacity="0.14" {...stroke} />
      <path d="m17 13.8 2.8 2.8-2.8 2.8-2.8-2.8z" fill="currentColor" fillOpacity="0.14" {...stroke} />
    </svg>
  ),

  select: (
    <svg viewBox="0 0 24 24" fill="none" style={iconStyle}>
      <path d="M6.3 4.8 18.3 11 13 13.2l-2.2 5z" fill="currentColor" fillOpacity="0.2" {...stroke} />
      <path d="m12.9 13.1 4.2 4.2" {...stroke} />
    </svg>
  ),
};
