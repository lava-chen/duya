"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  ChatCircleTextIcon,
  CheckIcon,
  MinusIcon,
  PaintBucketIcon,
  PlusIcon,
  QuotesIcon,
  TextAaIcon,
  XCircleIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  killTerminal,
  onTerminalExit,
  onTerminalOutput,
  resizeTerminal,
  spawnTerminal,
  suggestTerminalCommand,
  writeToTerminal,
  type TerminalHandle,
  type TerminalSuggestion,
} from "@/lib/terminal-ipc";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_STEP,
  useTerminalAppearanceStore,
} from "@/stores/terminal-appearance-store";
import { TERMINAL_THEME_PRESETS, resolveTerminalTheme } from "@/lib/terminal-themes";
import type { PageTab } from "./registry";

interface Props {
  tab: PageTab;
  embedded?: boolean;
}

type Status = "spawning" | "ready" | "exited" | "error";

/** Renderer actually powering the terminal: GPU (WebGL) or the DOM fallback. */
type RendererKind = "webgl" | "dom";

interface QuoteEventDetail {
  terminalId: string;
  title: string;
  shell: string;
  cwd: string;
  text: string;
  timestamp: number;
}

function clampMenuPosition(left: number, top: number, width: number, height: number) {
  return {
    left: Math.max(8, Math.min(left, Math.max(8, width - 168))),
    top: Math.max(8, Math.min(top, Math.max(8, height - 42))),
  };
}

function applyInputToLine(current: string, data: string): { line: string; submitted?: string } {
  let line = current;
  let submitted: string | undefined;
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      submitted = line;
      line = "";
    } else if (ch === "\u007f" || ch === "\b") {
      line = line.slice(0, -1);
    } else if (ch === "\u0003" || ch === "\u0015") {
      line = "";
    } else if (ch === "\t" || ch === "\u001b") {
      // Shell owns completion and escape sequences.
    } else if (ch >= " ") {
      line += ch;
    }
  }
  return { line, submitted };
}

export function TerminalPanel({ tab }: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const currentLineRef = useRef("");
  const suggestionRef = useRef<TerminalSuggestion | null>(null);
  const writeSeqRef = useRef(0);
  const webglRef = useRef<WebglAddon | null>(null);
  const [status, setStatus] = useState<Status>("spawning");
  const [handle, setHandle] = useState<TerminalHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<{ left: number; top: number } | null>(null);
  const [suggestion, setSuggestion] = useState<TerminalSuggestion | null>(null);
  const [renderer, setRenderer] = useState<RendererKind>("dom");
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const fontSize = useTerminalAppearanceStore((s) => s.fontSize);
  const themeId = useTerminalAppearanceStore((s) => s.themeId);
  const stepFontSize = useTerminalAppearanceStore((s) => s.stepFontSize);
  const resetFontSize = useTerminalAppearanceStore((s) => s.resetFontSize);
  const setThemeId = useTerminalAppearanceStore((s) => s.setThemeId);

  // Mirror store-backed appearance into refs so the (mount-once) terminal
  // creation effect can read the latest values without being torn down.
  const themeIdRef = useRef(themeId);
  const fontSizeRef = useRef(fontSize);
  useEffect(() => {
    themeIdRef.current = themeId;
    fontSizeRef.current = fontSize;
  }, [fontSize, themeId]);

  const applyTheme = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = resolveTerminalTheme(themeIdRef.current);
  }, []);

  const fitAndResize = useCallback(() => {
    const term = terminalRef.current;
    const fit = fitAddonRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      void resizeTerminal(tab.id, term.cols, term.rows);
    } catch {
      // The element can briefly be display:none while the panel switches.
    }
  }, [tab.id]);

  const refreshSuggestion = useCallback(async (line: string) => {
    const h = handleRef.current;
    const prefix = line.trimStart();
    if (!h || prefix.length < 2) {
      suggestionRef.current = null;
      setSuggestion(null);
      return;
    }
    const seq = ++writeSeqRef.current;
    const suggestions = await suggestTerminalCommand(prefix, h.shell, h.cwd, 1);
    if (seq !== writeSeqRef.current) return;
    const next = suggestions[0] ?? null;
    suggestionRef.current = next;
    setSuggestion(next);
  }, []);

  const sendData = useCallback(
    (data: string) => {
      const next = applyInputToLine(currentLineRef.current, data);
      currentLineRef.current = next.line;
      void refreshSuggestion(next.line);
      void writeToTerminal(tab.id, data);
    },
    [refreshSuggestion, tab.id],
  );

  const showSelectionMenuAt = useCallback((clientX: number, clientY: number) => {
    const panel = panelRef.current;
    const text = terminalRef.current?.getSelection().trim();
    if (!panel || !text) {
      setSelectionMenu(null);
      return;
    }
    const rect = panel.getBoundingClientRect();
    setSelection(text);
    setSelectionMenu(
      clampMenuPosition(clientX - rect.left - 84, clientY - rect.top + 10, rect.width, rect.height)
    );
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      // The Unicode 11 width addon reads `term.unicode`, a proposed API.
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Cascadia Mono, SFMono-Regular, Consolas, monospace",
      fontSize: fontSizeRef.current,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: resolveTerminalTheme(themeIdRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    terminalRef.current = term;
    fitAddonRef.current = fit;

    // Unicode 11 width tables: correct cell widths for CJK and emoji.
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
    } catch {
      // Proposed API unavailable; keep the bundled Unicode 6 tables.
    }

    // GPU-accelerated renderer, degrading gracefully to the DOM renderer when
    // WebGL2 is unavailable or the context is lost (e.g. GPU reset).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglRef.current = null;
        setRenderer("dom");
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      setRenderer("webgl");
    } catch {
      webglRef.current = null;
      setRenderer("dom");
    }

    // Ctrl/Cmd +/-/0 adjust the terminal font size. Consuming the event keeps
    // it away from the shell and from the browser's page-zoom shortcut.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.altKey) return true;
      if (!event.ctrlKey && !event.metaKey) return true;
      if (event.key === "=" || event.key === "+") {
        stepFontSize(TERMINAL_FONT_SIZE_STEP);
        return false;
      }
      if (event.key === "-" || event.key === "_") {
        stepFontSize(-TERMINAL_FONT_SIZE_STEP);
        return false;
      }
      if (event.key === "0") {
        resetFontSize();
        return false;
      }
      return true;
    });

    fitAndResize();

    const dataDisposable = term.onData((data) => {
      if (data === "\t" && suggestionRef.current) {
        const suffix = suggestionRef.current.suffix;
        currentLineRef.current += suffix;
        suggestionRef.current = null;
        setSuggestion(null);
        void writeToTerminal(tab.id, suffix);
        return;
      }
      sendData(data);
    });

    const selectionDisposable = term.onSelectionChange(() => {
      const selectedText = term.getSelection().trim();
      setSelection(selectedText);
      if (!selectedText) {
        setSelectionMenu(null);
        return;
      }
    });

    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(container);

    // Re-resolve the palette when the app theme flips; only the 'auto' preset
    // depends on the CSS variables, but a no-op update for the rest is cheap.
    const themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      dataDisposable.dispose();
      selectionDisposable.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      webglRef.current?.dispose();
      webglRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      term.dispose();
    };
  }, [applyTheme, fitAndResize, resetFontSize, sendData, stepFontSize, tab.id]);

  // Live-apply font size without re-creating the terminal.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitAndResize();
  }, [fitAndResize, fontSize]);

  // Live-apply theme changes.
  useEffect(() => {
    applyTheme();
  }, [applyTheme, themeId]);

  // Dismiss the appearance menu on outside click or Escape.
  useEffect(() => {
    if (!appearanceOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".terminal-panel-appearance, .terminal-appearance-menu")) return;
      setAppearanceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAppearanceOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [appearanceOpen]);

  useEffect(() => {
    let alive = true;
    setStatus("spawning");
    setError(null);

    const term = terminalRef.current;
    const cols = term?.cols ?? 80;
    const rows = term?.rows ?? 24;

    spawnTerminal({
      id: tab.id,
      cwd: typeof tab.params?.cwd === "string" ? tab.params.cwd : undefined,
      shell: typeof tab.params?.shell === "string" ? (tab.params.shell as never) : undefined,
      cols,
      rows,
      title: tab.title,
    })
      .then((res) => {
        if (!alive) return;
        if (!res.ok || !res.handle) {
          setStatus("error");
          setError(res.error ?? "Unable to start terminal");
          return;
        }
        handleRef.current = res.handle;
        setHandle(res.handle);
        setStatus(res.handle.status === "exited" ? "exited" : "ready");
        if (res.scrollback && terminalRef.current) {
          terminalRef.current.write(res.scrollback);
        }
        fitAndResize();
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      alive = false;
    };
  }, [fitAndResize, tab.id, tab.params, tab.title]);

  useEffect(() => {
    const offOut = onTerminalOutput((evt) => {
      if (evt.id !== tab.id) return;
      terminalRef.current?.write(evt.data);
    });
    const offExit = onTerminalExit((evt) => {
      if (evt.id !== tab.id) return;
      setStatus("exited");
      setHandle((prev) => prev ? { ...prev, status: "exited", exitCode: evt.code ?? undefined } : prev);
    });
    return () => {
      offOut();
      offExit();
    };
  }, [tab.id]);

  const handleRestart = useCallback(async () => {
    setStatus("spawning");
    setError(null);
    setSelection("");
    setSuggestion(null);
    suggestionRef.current = null;
    currentLineRef.current = "";
    terminalRef.current?.clear();
    await killTerminal(tab.id);
    const term = terminalRef.current;
    const res = await spawnTerminal({
      id: tab.id,
      cwd: handleRef.current?.cwd,
      shell: handleRef.current?.shell,
      cols: term?.cols ?? 80,
      rows: term?.rows ?? 24,
      title: tab.title,
    });
    if (!res.ok || !res.handle) {
      setStatus("error");
      setError(res.error ?? "Unable to restart terminal");
      return;
    }
    handleRef.current = res.handle;
    setHandle(res.handle);
    setStatus("ready");
    fitAndResize();
  }, [fitAndResize, tab.id, tab.title]);

  const handleQuoteSelection = useCallback(() => {
    const h = handleRef.current;
    const text = terminalRef.current?.getSelection().trim() || selection;
    if (!h || !text) return;
    const detail: QuoteEventDetail = {
      terminalId: h.id,
      title: h.title,
      shell: h.shell,
      cwd: h.cwd,
      text,
      timestamp: Date.now(),
    };
    window.dispatchEvent(new CustomEvent<QuoteEventDetail>("terminal-add-to-input", { detail }));
    terminalRef.current?.clearSelection();
    setSelection("");
    setSelectionMenu(null);
  }, [selection]);

  return (
    <div ref={panelRef} className="terminal-panel terminal-panel-xterm">
      {(status === "spawning" || status === "exited" || status === "error") && (
        <div className="terminal-panel-inline-status" data-status={status}>
          {status === "spawning"
            ? "Starting terminal..."
            : status === "exited"
              ? "Process exited"
              : error ?? "Failed to start"}
        </div>
      )}
      <div className="terminal-panel-toolbar">
        <span className="terminal-panel-status" data-status={status}>
          {status === "ready" && handle ? (
            <>
              <span>{handle.shell}</span>
              <span className="terminal-panel-status-sep">·</span>
              <span className="terminal-panel-cwd" title={handle.cwd}>{handle.cwd}</span>
            </>
          ) : status === "spawning" ? (
            <span>Starting...</span>
          ) : status === "exited" ? (
            <>
              <XCircleIcon size={11} stroke={2.5} />
              <span>Process exited</span>
            </>
          ) : (
            <>
              <XCircleIcon size={11} stroke={2.5} />
              <span>{error ?? "Failed to start"}</span>
            </>
          )}
        </span>
        {selection && (
          <IconButton
            type="button"
            variant="default"
            shape="square"
            size="sm"
            className="terminal-panel-restart"
            onClick={handleQuoteSelection}
            title="Add selection to chat"
            aria-label="Add terminal selection to chat"
          >
            <QuotesIcon size={12} stroke={2.5} />
          </IconButton>
        )}
        <IconButton
          type="button"
          variant="default"
          shape="square"
          size="sm"
          className="terminal-panel-restart"
          onClick={handleRestart}
          title="Restart terminal"
          aria-label="Restart terminal"
        >
          <ArrowClockwiseIcon size={12} stroke={2.5} />
        </IconButton>
      </div>

      <div className="terminal-panel-appearance" data-open={appearanceOpen ? "true" : undefined}>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          size="sm"
          className="terminal-appearance-btn"
          onClick={() => stepFontSize(-TERMINAL_FONT_SIZE_STEP)}
          disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
          title={t("terminal.decreaseFontSize")}
          aria-label={t("terminal.decreaseFontSize")}
        >
          <TextAaIcon size={13} stroke={2.2} />
          <MinusIcon size={8} stroke={3} className="terminal-appearance-decor" />
        </IconButton>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          size="sm"
          className="terminal-appearance-btn"
          onClick={() => stepFontSize(TERMINAL_FONT_SIZE_STEP)}
          disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
          title={t("terminal.increaseFontSize")}
          aria-label={t("terminal.increaseFontSize")}
        >
          <TextAaIcon size={13} stroke={2.2} />
          <PlusIcon size={8} stroke={3} className="terminal-appearance-decor terminal-appearance-decor-plus" />
        </IconButton>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          size="sm"
          className="terminal-appearance-btn"
          onClick={() => setAppearanceOpen((open) => !open)}
          title={t("terminal.appearance")}
          aria-label={t("terminal.appearance")}
          aria-haspopup="menu"
          aria-expanded={appearanceOpen}
        >
          <PaintBucketIcon size={13} stroke={2.2} />
        </IconButton>
      </div>

      {appearanceOpen && (
        <div className="terminal-appearance-menu" role="menu" aria-label={t("terminal.appearance")}>
          <div className="terminal-appearance-menu-title">{t("terminal.theme")}</div>
          {TERMINAL_THEME_PRESETS.map((preset) => {
            const active = preset.id === themeId;
            return (
              <button
                key={preset.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="terminal-appearance-menu-item"
                data-active={active ? "true" : undefined}
                onClick={() => {
                  setThemeId(preset.id);
                  setAppearanceOpen(false);
                }}
              >
                <span
                  className="terminal-appearance-swatch"
                  style={{
                    background: preset.swatch[0],
                    color: preset.swatch[1],
                    boxShadow: `inset 0 0 0 1px ${preset.swatch[2]}`,
                  }}
                >
                  <span className="terminal-appearance-swatch-glyph">{">_"}</span>
                </span>
                <span className="terminal-appearance-menu-label">{t(preset.labelKey)}</span>
                {active && (
                  <CheckIcon size={13} stroke={2.5} className="terminal-appearance-menu-check" />
                )}
              </button>
            );
          })}
          <div className="terminal-appearance-menu-foot">
            <span className="terminal-appearance-menu-foot-label">{t("terminal.fontSize")}</span>
            <span className="terminal-appearance-menu-foot-value">{fontSize}px</span>
            <span className="terminal-appearance-menu-foot-renderer" data-renderer={renderer}>
              {renderer === "webgl" ? "WebGL" : "DOM"}
            </span>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className="terminal-xterm-host"
        onMouseUp={(event) => {
          window.setTimeout(() => showSelectionMenuAt(event.clientX, event.clientY), 0);
        }}
      />

      {selection && selectionMenu && (
        <div
          className="terminal-selection-menu"
          style={{ left: selectionMenu.left, top: selectionMenu.top }}
        >
          <Button type="button" variant="ghost" size="sm" onClick={handleQuoteSelection}>
            <ChatCircleTextIcon size={14} />
            <span>{t('terminal.addToChat')}</span>
          </Button>
        </div>
      )}

      {suggestion && (
        <div className="terminal-suggestion">
          <span className="terminal-suggestion-key">Tab</span>
          <span className="terminal-suggestion-command">{suggestion.command}</span>
        </div>
      )}
    </div>
  );
}
