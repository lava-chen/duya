"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowClockwise, ChatCircleText, Quotes, XCircle } from "@phosphor-icons/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
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
import type { PageTab } from "./registry";

interface Props {
  tab: PageTab;
  embedded?: boolean;
}

type Status = "spawning" | "ready" | "exited" | "error";

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

function applyTerminalTheme(term: Terminal) {
  term.options.theme = terminalTheme();
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim() || "#111111",
    foreground: styles.getPropertyValue("--text").trim() || "#e5e7eb",
    cursor: styles.getPropertyValue("--accent").trim() || "#7c9cff",
    selectionBackground: "rgba(124, 156, 255, 0.28)",
    black: "#1f2430",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#414868",
    brightRed: "#ff7a93",
    brightGreen: "#b9f27c",
    brightYellow: "#ffcf7a",
    brightBlue: "#8db0ff",
    brightMagenta: "#caa9ff",
    brightCyan: "#9be8ff",
    brightWhite: "#ffffff",
  };
}

export function TerminalPanel({ tab }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const currentLineRef = useRef("");
  const suggestionRef = useRef<TerminalSuggestion | null>(null);
  const writeSeqRef = useRef(0);
  const [status, setStatus] = useState<Status>("spawning");
  const [handle, setHandle] = useState<TerminalHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<{ left: number; top: number } | null>(null);
  const [suggestion, setSuggestion] = useState<TerminalSuggestion | null>(null);

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
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Cascadia Mono, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    terminalRef.current = term;
    fitAddonRef.current = fit;
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

    const themeObserver = new MutationObserver(() => {
      if (terminalRef.current) applyTerminalTheme(terminalRef.current);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      dataDisposable.dispose();
      selectionDisposable.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      term.dispose();
    };
  }, [fitAndResize, sendData, tab.id]);

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
              <XCircle size={11} weight="bold" />
              <span>Process exited</span>
            </>
          ) : (
            <>
              <XCircle size={11} weight="bold" />
              <span>{error ?? "Failed to start"}</span>
            </>
          )}
        </span>
        {selection && (
          <button
            type="button"
            className="terminal-panel-restart"
            onClick={handleQuoteSelection}
            title="Add selection to chat"
            aria-label="Add terminal selection to chat"
          >
            <Quotes size={12} weight="bold" />
          </button>
        )}
        <button
          type="button"
          className="terminal-panel-restart"
          onClick={handleRestart}
          title="Restart terminal"
          aria-label="Restart terminal"
        >
          <ArrowClockwise size={12} weight="bold" />
        </button>
      </div>

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
          <button type="button" onClick={handleQuoteSelection}>
            <ChatCircleText size={14} weight="regular" />
            <span>添加到对话</span>
          </button>
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
