'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { buildReceiverSrcdoc } from '@/lib/widget-sanitizer';
import { WIDGET_CSS_BRIDGE } from '@/lib/widget-css-bridge';
import { CopyIcon, CheckIcon, DownloadSimpleIcon } from '@/components/icons';

interface WidgetRendererProps {
  widgetCode: string;
  isStreaming: boolean;
  showOverlay?: boolean;
}

const DEBOUNCE_MS = 120;

const _heightCache = new Map<string, number>();

function computeWidgetCacheKey(widgetCode: string): string {
  let hash = 0;
  for (let i = 0; i < widgetCode.length; i++) {
    const ch = widgetCode.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

export function clearWidgetHeightCache(): void {
  _heightCache.clear();
}

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'dark';
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const attr = root.getAttribute('data-theme');
      setTheme(attr === 'light' ? 'light' : 'dark');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function getFileExtension(code: string): string {
  const trimmed = code.trim().toLowerCase();
  if (trimmed.startsWith('<svg')) return 'svg';
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) return 'html';
  if (trimmed.startsWith('<')) return 'html';
  return 'html';
}

function WidgetActions({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  const handleDownload = (ext: string) => {
    const blob = new Blob([code], { type: ext === 'svg' ? 'image/svg+xml' : 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `widget.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMenuOpen(false);
  };

  const ext = getFileExtension(code);

  return (
    <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
      <button
        onClick={handleCopy}
        className="p-1.5 rounded-md bg-[var(--bg-canvas)]/80 hover:bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text)] border border-[var(--border)]/50 backdrop-blur-sm transition-colors"
        title="Copy source"
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(v => !v)}
          className="p-1.5 rounded-md bg-[var(--bg-canvas)]/80 hover:bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text)] border border-[var(--border)]/50 backdrop-blur-sm transition-colors"
          title="Download"
        >
          <DownloadSimpleIcon size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-1 w-36 rounded-lg border border-[var(--border)] bg-[var(--bg-canvas)] shadow-lg overflow-hidden">
            <button
              onClick={() => handleDownload(ext)}
              className="w-full text-left px-3 py-2 text-xs text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              Download .{ext}
            </button>
            <button
              onClick={() => handleDownload('svg')}
              className="w-full text-left px-3 py-2 text-xs text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              Download .svg
            </button>
            <button
              onClick={() => handleDownload('html')}
              className="w-full text-left px-3 py-2 text-xs text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              Download .html
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const WidgetRenderer = React.memo(function WidgetRenderer({
  widgetCode,
  isStreaming,
  showOverlay,
}: WidgetRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastCodeRef = useRef(widgetCode);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const theme = useTheme();

  const cacheKey = computeWidgetCacheKey(widgetCode);

  const syncHeight = useCallback((newHeight: number) => {
    if (newHeight <= 0) return;
    setHeight(prev => {
      if (prev != null && newHeight <= prev) return prev;
      _heightCache.set(cacheKey, newHeight);
      return newHeight;
    });
  }, [cacheKey]);

  const buildSrcdoc = useCallback((code: string, streaming: boolean) => {
    return buildReceiverSrcdoc(code, streaming, WIDGET_CSS_BRIDGE);
  }, []);

  const buildSrcdocRef = useRef(buildSrcdoc);
  buildSrcdocRef.current = buildSrcdoc;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const srcdoc = buildSrcdocRef.current(widgetCode, isStreaming);
    iframe.srcdoc = srcdoc;
    setError(null);
    setLoading(true);
    lastCodeRef.current = widgetCode;
  }, [widgetCode, isStreaming, cacheKey]);

  useEffect(() => {
    if (isStreaming) return;
    const cached = _heightCache.get(cacheKey);
    if (cached != null) {
      setHeight(cached);
    }
  }, [isStreaming, cacheKey]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || !e.data.type) return;
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;

      switch (e.data.type) {
        case 'widget:ready':
          setLoading(false);
          break;
        case 'widget:resize':
          if (typeof e.data.height === 'number' && e.data.height > 0) {
            syncHeight(e.data.height);
          }
          break;
        case 'widget:link':
          if (e.data.href) {
            window.open(e.data.href, '_blank');
          }
          break;
        case 'widget:sendMessage':
          if (e.data.text && typeof window !== 'undefined') {
            const bridge = ((window as unknown) as Record<string, unknown>).__widgetSendMessage as ((text: string) => void) | undefined;
            bridge?.(e.data.text);
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [syncHeight]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'widget:theme', theme }, '*');
  }, [theme]);

  useEffect(() => {
    if (!isStreaming) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) return;
      if (widgetCode !== lastCodeRef.current) {
        const srcdoc = buildSrcdocRef.current(widgetCode, true);
        iframe.srcdoc = srcdoc;
        lastCodeRef.current = widgetCode;
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [widgetCode, isStreaming]);

  useEffect(() => {
    if (isStreaming) return;
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    const srcdoc = buildSrcdocRef.current(widgetCode, false);
    iframe.contentWindow.postMessage({ type: 'widget:finalize', srcdoc }, '*');
  }, [isStreaming, widgetCode]);

  const iframeError = useCallback(() => {
    setError('Widget failed to load');
    setLoading(false);
  }, []);

  const iframeLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const displayHeight = height ?? _heightCache.get(cacheKey) ?? 120;

  return (
    <div
      className="widget-renderer my-3"
      style={{
        position: 'relative',
        minHeight: '60px',
      }}
    >
      {!isStreaming && !error && <WidgetActions code={widgetCode} />}
      {error ? (
        <div className="flex items-center justify-center p-4 text-sm text-red-500">
          {error}
        </div>
      ) : (
        <>
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-canvas)]/60">
              <div className="widget-shimmer w-8 h-8 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin" />
            </div>
          )}
          {showOverlay && (
            <div className="absolute bottom-2 right-2 z-10 px-2 py-0.5 text-[10px] rounded bg-[var(--bg-canvas)]/80 text-[var(--text-secondary)] border border-[var(--border)]">
              streaming...
            </div>
          )}
          <iframe
            ref={iframeRef}
            sandbox="allow-scripts"
            className="w-full block"
            style={{
              border: 'none',
              height: `${displayHeight}px`,
              minHeight: '60px',
              background: 'transparent',
              overflow: 'hidden',
            }}
            scrolling="no"
            title="Widget"
            onError={iframeError}
            onLoad={iframeLoad}
          />
        </>
      )}
    </div>
  );
});
