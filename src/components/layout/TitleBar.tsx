"use client";

interface TitleBarProps {
  sidebarWidth?: number;
}

export function TitleBar({ sidebarWidth = 260 }: TitleBarProps) {
  const brandIconSrc = `${import.meta.env.BASE_URL}icon.png`;

  // Detect platform for window controls layout (macOS traffic lights on left, Windows on right)
  const isMac = window.electronAPI?.versions?.platform === "darwin";

  return (
    <div
      className={`titlebar-drag-region${isMac ? " is-mac" : " is-win"}`}
      style={{
        "--window-controls-offset": isMac ? "70px" : "0px",
      } as React.CSSProperties}
    >
      <div className="titlebar-brand">
        <img
          src={brandIconSrc}
          alt="DUYA"
          className="titlebar-logo"
        />
        <span className="titlebar-brand-text">Duya</span>
        <span
          className="titlebar-beta-badge"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            padding: "2px 6px",
            borderRadius: "4px",
            background: "var(--accent)",
            color: "white",
            marginLeft: "6px",
            letterSpacing: "0.5px",
          }}
        >
          BETA
        </span>
      </div>
      <div className="titlebar-spacer" style={{ width: sidebarWidth }} />
      <div className="titlebar-content-area" />
    </div>
  );
}
