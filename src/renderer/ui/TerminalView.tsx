import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "./i18n";

// Matches: path/to/file.ts:42 or path/to/file.ts:42:10 or ./file.ts:10
// Note: longer extensions must come before shorter ones (tsx before ts, jsx before js, etc.)
const FILE_PATH_REGEX = new RegExp(
  String.raw`(?:^|[\s'"({\[])((?:\.{1,2}\/|\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx|ts|jsx|js|mjs|cjs|json|scss|css|less|html|md|yaml|yml|toml|py|go))(?::(\d+))?(?::(\d+))?`,
  "g"
);

type Props = {
  tabId: string;
  sessionId?: string;
  onSessionId: (sessionId: string) => void;
  initialCommand?: string;
  onDidRunInitialCommand?: (sessionId: string) => void;
  isActive: boolean;
  isPaused?: boolean;
  scrollback?: number;
  slot?: number;
  projectRootPath?: string;
  onOpenUrl: (url: string) => void;
  onOpenFile?: (relPath: string, line?: number, column?: number) => void;
};

type ContextMenuState = { isOpen: false } | { isOpen: true; x: number; y: number };

function normalizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    return url.toString();
  } catch {
    return raw;
  }
}

function normalizeSlashes(p: string) {
  return p.replace(/[\\\\]+/g, "/");
}

function normalizeRootPath(p?: string) {
  if (!p) return "";
  return normalizeSlashes(p).replace(/\/+$/, "");
}

function isProbablyRelativePath(p: string) {
  if (!p) return false;
  if (p.startsWith("/")) return false;
  if (p.startsWith("./") || p.startsWith("../")) return true;
  return !p.includes(":\\"); // avoid Windows drive letter heuristic
}

function toProjectRelativePath(projectRoot: string, rawPath: string): string | null {
  if (!projectRoot) return null;
  const root = normalizeRootPath(projectRoot);
  const p = normalizeSlashes(rawPath);

  if (!p) return null;

  if (p.startsWith(root + "/")) return p.slice(root.length + 1);
  if (p === root) return "";

  if (isProbablyRelativePath(p)) {
    const cleaned = p.replace(/^\.\/+/, "");
    if (cleaned.startsWith("..")) return null;
    return cleaned;
  }

  return null;
}

function getRendererPreference(): "auto" | "dom" | "canvas" | "webgl" {
  try {
    const v = String(localStorage.getItem("xcoding.terminal.renderer") ?? "").toLowerCase();
    if (v === "auto") return "auto";
    if (v === "webgl") return "webgl";
    if (v === "canvas") return "canvas";
    if (v === "dom") return "dom";
  } catch {
    // ignore
  }
  return "auto";
}

function readCssVar(name: string, fallback: string) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function getTerminalTheme() {
  const background = readCssVar("--vscode-terminal-background", "#1e1e1e") || "#1e1e1e";
  const foreground = readCssVar("--vscode-terminal-foreground", "#cccccc") || "#cccccc";
  const cursor = readCssVar("--vscode-terminalCursor-foreground", foreground) || foreground;

  return { background, foreground, cursor };
}

export default function TerminalView({
  tabId,
  sessionId,
  onSessionId,
  initialCommand,
  onDidRunInitialCommand,
  isActive,
  isPaused = false,
  scrollback = 2000,
  slot,
  projectRootPath,
  onOpenUrl,
  onOpenFile
}: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const rendererAddonRef = useRef<{ dispose: () => void } | null>(null);
  const linkProviderDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const onSessionIdRef = useRef(onSessionId);
  const onOpenUrlRef = useRef(onOpenUrl);
  const onOpenFileRef = useRef(onOpenFile);
  const onDidRunInitialCommandRef = useRef(onDidRunInitialCommand);
  const isPausedRef = useRef(isPaused);
  const backendKindRef = useRef<"pty" | "proc">("pty");
  const initialCommandSentRef = useRef(false);

  const writeBufferRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposeOnDataRef = useRef<null | (() => void)>(null);

  const [backendKind, setBackendKind] = useState<"pty" | "proc">("pty");
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [menu, setMenu] = useState<ContextMenuState>({ isOpen: false });

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchOptions, setSearchOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false });
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const rootForLinks = useMemo(() => normalizeRootPath(projectRootPath), [projectRootPath]);

  useEffect(() => {
    onSessionIdRef.current = onSessionId;
  }, [onSessionId]);

  useEffect(() => {
    onOpenUrlRef.current = onOpenUrl;
  }, [onOpenUrl]);

  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);

  useEffect(() => {
    onDidRunInitialCommandRef.current = onDidRunInitialCommand;
  }, [onDidRunInitialCommand]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  function flushWriteBuffer() {
    if (!terminalRef.current) return;
    const buffered = writeBufferRef.current;
    writeBufferRef.current = "";
    if (!buffered) return;
    terminalRef.current.write(buffered);
  }

  function scheduleFlush() {
    if (flushTimerRef.current != null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushWriteBuffer();
    }, 30);
  }

  function scheduleResize(cols: number, rows: number) {
    const sid = sessionIdRef.current;
    if (!sid) return;
    pendingResizeRef.current = { cols, rows };
    if (resizeTimerRef.current != null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const next = pendingResizeRef.current;
      pendingResizeRef.current = null;
      if (!next) return;
      void window.xcoding.terminal.resize(sid, next.cols, next.rows);
    }, 120);
  }

  function fit() {
    const fitAddon = fitAddonRef.current;
    const term = terminalRef.current;
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
      scheduleResize(term.cols, term.rows);
    } catch {
      // ignore
    }
  }

  function closeMenu() {
    setMenu({ isOpen: false });
  }

  async function copySelection() {
    const term = terminalRef.current;
    if (!term) return;
    const text = term.getSelection();
    if (!text) return;
    await window.xcoding.os.copyText(text);
  }

  async function pasteFromClipboard() {
    const term = terminalRef.current;
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      term.paste(text);
    } catch {
      // ignore
    }
  }

  function toggleSearch(open?: boolean) {
    const next = typeof open === "boolean" ? open : !isSearchOpen;
    setIsSearchOpen(next);
    if (next) {
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    } else {
      searchAddonRef.current?.clearDecorations();
    }
  }

  function findNext() {
    if (!searchTerm) return;
    searchAddonRef.current?.findNext(searchTerm, {
      ...searchOptions,
      decorations: { matchBackground: "#094771", matchBorder: "#094771", activeMatchBackground: "#d18616", activeMatchBorder: "#d18616" }
    } as any);
  }

  function findPrevious() {
    if (!searchTerm) return;
    searchAddonRef.current?.findPrevious(searchTerm, {
      ...searchOptions,
      decorations: { matchBackground: "#094771", matchBorder: "#094771", activeMatchBackground: "#d18616", activeMatchBorder: "#d18616" }
    } as any);
  }

  useEffect(() => {
    if (!isActive) return;
    if (terminalRef.current) {
      try {
        terminalRef.current.focus();
      } catch {
        // ignore
      }
      fit();
      try {
        terminalRef.current.scrollToBottom();
      } catch {
        // ignore
      }
      return;
    }

    let disposed = false;

    const init = async () => {
      setError(null);
      setIsReady(false);

      let resolvedSessionId = sessionIdRef.current ?? sessionId ?? null;
      if (!resolvedSessionId) {
        const res = await window.xcoding.terminal.create({ slot });
        if (!res.ok || !res.sessionId) {
          if (disposed) return;
          setError(res.reason ?? "terminal_create_failed");
          return;
        }
        const kind = res.kind === "proc" ? "proc" : "pty";
        backendKindRef.current = kind;
        setBackendKind(kind);
        resolvedSessionId = res.sessionId;
        sessionIdRef.current = resolvedSessionId;
        onSessionIdRef.current(resolvedSessionId);
      } else {
        sessionIdRef.current = resolvedSessionId;
      }

      if (!containerRef.current) return;

      // Wait for layout to be ready (avoid opening into 0x0 container).
      for (let i = 0; i < 60; i += 1) {
        if (disposed) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 2 && rect.height > 2) break;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback,
        allowProposedApi: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 12,
        theme: getTerminalTheme()
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      const webLinksAddon = new WebLinksAddon((e, uri) => {
        e.preventDefault();
        onOpenUrlRef.current(normalizeUrl(uri));
      });
      const unicode11Addon = new Unicode11Addon();

      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = "11";

      const rendererPref = getRendererPreference();
      const tryCanvas = () => {
        try {
          const canvasAddon = new CanvasAddon();
          term.loadAddon(canvasAddon);
          rendererAddonRef.current = canvasAddon;
          return true;
        } catch {
          return false;
        }
      };
      const tryWebgl = () => {
        try {
          const webglAddon = new WebglAddon();
          term.loadAddon(webglAddon);
          rendererAddonRef.current = webglAddon;
          return true;
        } catch {
          return false;
        }
      };

      if (rendererPref === "webgl") {
        if (!tryWebgl()) tryCanvas();
      } else if (rendererPref === "canvas") {
        tryCanvas();
      } else if (rendererPref === "auto") {
        if (!tryWebgl()) tryCanvas();
      }

      if (onOpenFileRef.current && rootForLinks) {
        const disposable = (term as any).registerLinkProvider({
          provideLinks: (bufferLineNumber: number, callback: (links: any[] | undefined) => void) => {
            const line = term.buffer.active.getLine(bufferLineNumber - 1);
            if (!line) {
              callback(undefined);
              return;
            }
            const lineText = line.translateToString();
            const links: any[] = [];
            FILE_PATH_REGEX.lastIndex = 0;
            let match: RegExpExecArray | null = null;
            while ((match = FILE_PATH_REGEX.exec(lineText)) !== null) {
              const filePath = match[1] ?? "";
              const lineNum = match[2] ? Number.parseInt(match[2], 10) : undefined;
              const colNum = match[3] ? Number.parseInt(match[3], 10) : undefined;
              const resolvedRel = toProjectRelativePath(rootForLinks, filePath);
              if (!resolvedRel || !onOpenFileRef.current) continue;
              const startIndex = match.index + (match[0].length - filePath.length - (match[2] ? `:${match[2]}`.length : 0) - (match[3] ? `:${match[3]}`.length : 0));
              const endIndex = match.index + match[0].length;
              links.push({
                range: {
                  start: { x: startIndex + 1, y: bufferLineNumber },
                  end: { x: endIndex + 1, y: bufferLineNumber }
                },
                text: match[0].trim(),
                activate: () => onOpenFileRef.current?.(resolvedRel, lineNum, colNum)
              });
            }
            callback(links.length ? links : undefined);
          }
        });
        linkProviderDisposableRef.current = disposable;
      }

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      term.attachCustomKeyEventHandler((event) => {
        const isMod = event.ctrlKey || event.metaKey;
        if (event.type !== "keydown") return true;

        if (isMod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          toggleSearch(true);
          return false;
        }

        // Copy/paste behavior similar to EnsoAI:
        // - Cmd/Ctrl+C: copy if selection exists; otherwise let terminal receive SIGINT.
        // - Cmd/Ctrl+V: paste from clipboard.
        if (isMod && !event.altKey && event.key.toLowerCase() === "c") {
          if (term.hasSelection()) {
            void copySelection();
            return false;
          }
        }
        if (isMod && !event.altKey && event.key.toLowerCase() === "v") {
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        }
        return true;
      });

      term.open(containerRef.current);
      fit();

      // Mark ready as soon as xterm is opened. Buffer replay is best-effort and should not block UI.
      if (!disposed) setIsReady(true);

      // Replay recent output so remount doesn't look blank.
      void window.xcoding.terminal
        .getBuffer(resolvedSessionId, 200_000)
        .then((bufRes) => {
          if (disposed) return;
          if (terminalRef.current !== term) return;
          if (!bufRes.ok || !bufRes.data) return;
          term.write(bufRes.data);
          try {
            term.scrollToBottom();
          } catch {
            // ignore
          }
        })
        .catch(() => {
          // ignore
        });

      // Stream backend data with 30ms buffering.
      disposeOnDataRef.current = window.xcoding.terminal.onData(({ sessionId: incomingSessionId, data }) => {
        if (incomingSessionId !== resolvedSessionId) return;
        if (isPausedRef.current) return;
        writeBufferRef.current += data;
        scheduleFlush();
      });

      // Resize observer for fit.
      resizeObserverRef.current = new ResizeObserver(() => {
        if (disposed) return;
        if (!terminalRef.current) return;
        fit();
      });
      resizeObserverRef.current.observe(containerRef.current);

      term.onData((data) => {
        if (!resolvedSessionId) return;
        if (backendKindRef.current === "proc") {
          if (data === "\r") {
            term.write("\r\n");
            void window.xcoding.terminal.write(resolvedSessionId, "\n");
            return;
          }
          if (data === "\u007f") {
            term.write("\b \b");
            return;
          }
          term.write(data);
        }
        void window.xcoding.terminal.write(resolvedSessionId, data);
      });

      if (initialCommand && !initialCommandSentRef.current) {
        initialCommandSentRef.current = true;
        const cmd = initialCommand.endsWith("\n") ? initialCommand : `${initialCommand}\n`;
        try {
          if (backendKindRef.current === "proc") term.write(cmd);
        } catch {
          // ignore
        }
        try {
          await window.xcoding.terminal.write(resolvedSessionId, cmd);
          onDidRunInitialCommandRef.current?.(resolvedSessionId);
        } catch {
          // ignore
        }
      }

    };

    void init().catch((e) => {
      if (disposed) return;
      setError(e instanceof Error ? e.message : "terminal_init_failed");
    });

    return () => {
      disposed = true;
    };
  }, [isActive, rootForLinks, scrollback, sessionId, slot, tabId]);

  useEffect(() => {
    return () => {
      closeMenu();
      toggleSearch(false);
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current);
      if (resizeTimerRef.current != null) window.clearTimeout(resizeTimerRef.current);
      flushTimerRef.current = null;
      resizeTimerRef.current = null;
      disposeOnDataRef.current?.();
      disposeOnDataRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      try {
        linkProviderDisposableRef.current?.dispose();
      } catch {
        // ignore
      }
      linkProviderDisposableRef.current = null;
      // Renderer addons are owned by xterm's AddonManager; disposing them here can double-dispose
      // (e.g. WebglAddon) and crash on teardown. Let `terminal.dispose()` handle addon cleanup.
      rendererAddonRef.current = null;
      try {
        terminalRef.current?.dispose();
      } catch {
        // ignore
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      writeBufferRef.current = "";
      pendingResizeRef.current = null;
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    if (!isActive) return;
    try {
      terminalRef.current?.focus();
    } catch {
      // ignore
    }
    let cancelled = false;
    let tries = 0;
    const tick = () => {
      tries += 1;
      if (cancelled) return;
      fit();
      if (tries < 8) window.setTimeout(tick, 40);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  return (
    <div
      className="relative h-full w-full"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ isOpen: true, x: e.clientX, y: e.clientY });
      }}
      onClick={() => closeMenu()}
    >
      <div className="h-full w-full" ref={containerRef} />

      {error ? (
        <div className="pointer-events-none absolute inset-0 p-3 text-xs text-red-400">
          {t("terminalError")} {error}
        </div>
      ) : backendKind === "proc" ? (
        <div className="pointer-events-none absolute left-0 right-0 top-0 p-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
          {t("terminalFallbackMode")}
        </div>
      ) : !isReady ? (
        <div className="pointer-events-none absolute inset-0 p-3 text-xs text-[var(--vscode-descriptionForeground)]">{t("startingTerminal")}</div>
      ) : null}

      {isSearchOpen ? (
        <div className="absolute left-2 right-2 top-2 z-20 flex items-center gap-1 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-1 text-[11px] text-[var(--vscode-foreground)] shadow">
          <input
            ref={searchInputRef}
            className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
            placeholder={t("find")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                toggleSearch(false);
              }
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrevious();
                else findNext();
              }
            }}
          />
          <button
            className={[
              "rounded p-1",
              searchOptions.caseSensitive ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]" : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            ].join(" ")}
            onClick={() => setSearchOptions((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
            type="button"
            title={t("matchCase")}
          >
            <CaseSensitive className="h-4 w-4" />
          </button>
          <button
            className={[
              "rounded p-1",
              searchOptions.wholeWord ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]" : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            ].join(" ")}
            onClick={() => setSearchOptions((o) => ({ ...o, wholeWord: !o.wholeWord }))}
            type="button"
            title={t("matchWholeWord")}
          >
            <WholeWord className="h-4 w-4" />
          </button>
          <button
            className={[
              "rounded p-1",
              searchOptions.regex ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]" : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            ].join(" ")}
            onClick={() => setSearchOptions((o) => ({ ...o, regex: !o.regex }))}
            type="button"
            title={t("useRegex")}
          >
            <Regex className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => findPrevious()}
            type="button"
            title={t("previous")}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => findNext()}
            type="button"
            title={t("next")}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => toggleSearch(false)}
            type="button"
            title={t("close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {menu.isOpen ? (
        <div
          className="fixed z-50 min-w-[160px] rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-1 text-[11px] text-[var(--vscode-foreground)] shadow"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              void copySelection();
            }}
            type="button"
          >
            {t("copy")}
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              void pasteFromClipboard();
            }}
            type="button"
          >
            {t("paste")}
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              terminalRef.current?.selectAll();
            }}
            type="button"
          >
            {t("selectAll")}
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              terminalRef.current?.clear();
            }}
            type="button"
          >
            {t("clear")}
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              toggleSearch(true);
            }}
            type="button"
          >
            {t("find")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
