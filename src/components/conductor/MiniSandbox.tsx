"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { buildReceiverSrcdoc } from "@/lib/widget-sanitizer";
import { WIDGET_CSS_BRIDGE } from "@/lib/widget-css-bridge";

interface MiniSandboxProps {
  html: string;
  js?: string;
  css?: string;
  streaming?: boolean;
  readOnly?: boolean;
  onMessage?: (msg: { type: string; [k: string]: unknown }) => void;
}

const LOADING_GRADIENT = "linear-gradient(135deg, var(--bg-hover) 25%, transparent 25%, transparent 50%, var(--bg-hover) 50%, var(--bg-hover) 75%, transparent 75%, transparent)";

function buildSandboxSrcdoc(html: string, css?: string, js?: string): string {
  const extraCss = css ? `<style>${css}</style>` : "";
  const extraJs = js ? `<script>${js}</script>` : "";
  const combined = `${extraCss}\n${html}\n${extraJs}`;
  return buildReceiverSrcdoc(combined, false, WIDGET_CSS_BRIDGE);
}

export const MiniSandbox: React.FC<MiniSandboxProps> = ({
  html,
  js,
  css,
  streaming = false,
  readOnly = false,
  onMessage,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const srcdoc = buildSandboxSrcdoc(html, css, js);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    iframe.srcdoc = srcdoc;
    setError(null);
    setLoading(true);
  }, [srcdoc]);

  const handleMessage = useCallback(
    (e: MessageEvent) => {
      if (!e.data || !e.data.type) return;
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;

      if (e.data.type === "widget:ready") {
        setLoading(false);
      } else if (e.data.type === "widget:resize") {
        setLoading(false);
      }

      onMessage?.(e.data);
    },
    [onMessage]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const iframeError = useCallback(() => {
    setError("Element failed to load");
    setLoading(false);
  }, []);

  const iframeLoad = useCallback(() => {
    setLoading(false);
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--error)] p-2">
        {error}
      </div>
    );
  }

  return (
    <div className="mini-sandbox relative w-full h-full min-h-0">
      {loading && (
        <div
          className="absolute inset-0 z-10"
          style={{ background: LOADING_GRADIENT, backgroundSize: "200% 100%" }}
        />
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        className="w-full h-full block"
        style={{
          border: "none",
          background: "transparent",
          overflow: "hidden",
          pointerEvents: readOnly ? "none" : "auto",
        }}
        scrolling="no"
        title="Element Sandbox"
        onError={iframeError}
        onLoad={iframeLoad}
      />
    </div>
  );
};