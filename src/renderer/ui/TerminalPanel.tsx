import { Plus, SquareSplitHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import TerminalView from "./TerminalView";
import { useI18n } from "./i18n";

export type TerminalEntry = { id: string; title: string; sessionId?: string };

export type PanelTabId = "terminal" | "previewConsole" | "previewNetwork";

export type TerminalPanelState = {
  isVisible: boolean;
  height: number;
  activeTab: PanelTabId;
  terminals: TerminalEntry[];
  viewIds: string[]; // 1..3
  focusedView: number; // 0..viewIds.length-1
};

type Props = {
  slot: number;
  projectRootPath?: string;
  scrollback?: number;
  state: TerminalPanelState;
  openPreviewIds?: string[];
  onUpdate: (updater: (prev: TerminalPanelState) => TerminalPanelState) => void;
  onOpenUrl: (url: string) => void;
  onOpenFile: (relPath: string, line?: number, column?: number) => void;
  activePreviewId?: string | null;
  activePreviewUrl?: string | null;
};

type PreviewConsoleEntry = { level: string; text: string; timestamp: number };
type PreviewNetworkEntry = { requestId: string; url: string; status: number; method: string; timestamp: number };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function nextTerminalTitle(count: number) {
  return `Terminal ${count}`;
}

function tabButtonClass(isActive: boolean) {
  return [
    "rounded px-2 py-1 text-[11px]",
    isActive
      ? "bg-[var(--vscode-tab-activeBackground)] text-[var(--vscode-tab-activeForeground)]"
      : "text-[var(--vscode-tab-inactiveForeground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]"
  ].join(" ");
}

export default function TerminalPanel({
  slot,
  projectRootPath,
  scrollback = 1500,
  state,
  openPreviewIds = [],
  onUpdate,
  onOpenUrl,
  onOpenFile,
  activePreviewId = null,
  activePreviewUrl = null
}: Props) {
  const { t } = useI18n();
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const draggingTerminalIdRef = useRef<string | null>(null);

  const consoleByPreviewIdRef = useRef<Record<string, PreviewConsoleEntry[]>>({});
  const networkByPreviewIdRef = useRef<Record<string, PreviewNetworkEntry[]>>({});
  const logsRafRef = useRef<number | null>(null);
  const [, forceRerender] = useState(0);

  function scheduleRerender() {
    if (logsRafRef.current != null) return;
    logsRafRef.current = requestAnimationFrame(() => {
      logsRafRef.current = null;
      forceRerender((v) => v + 1);
    });
  }

  useEffect(() => {
    const offConsole = window.xcoding.preview.onConsole((e) => {
      const previewId = String(e.previewId ?? "");
      if (!previewId) return;
      const prev = consoleByPreviewIdRef.current[previewId] ?? [];
      consoleByPreviewIdRef.current[previewId] = [...prev.slice(-199), { level: e.level, text: e.text, timestamp: e.timestamp }];
      scheduleRerender();
    });

    const offNetwork = window.xcoding.preview.onNetwork((e) => {
      const previewId = String(e.previewId ?? "");
      if (!previewId) return;
      const prev = networkByPreviewIdRef.current[previewId] ?? [];
      networkByPreviewIdRef.current[previewId] = [
        ...prev.slice(-199),
        { requestId: e.requestId, url: e.url, status: e.status, method: e.method, timestamp: e.timestamp }
      ];
      scheduleRerender();
    });

    return () => {
      offConsole();
      offNetwork();
      if (logsRafRef.current != null) cancelAnimationFrame(logsRafRef.current);
      logsRafRef.current = null;
    };
  }, []);

  useEffect(() => {
    const keep = new Set(openPreviewIds);
    const consoles = consoleByPreviewIdRef.current;
    for (const id of Object.keys(consoles)) {
      if (!keep.has(id)) delete consoles[id];
    }
    const networks = networkByPreviewIdRef.current;
    for (const id of Object.keys(networks)) {
      if (!keep.has(id)) delete networks[id];
    }
  }, [openPreviewIds]);

  useEffect(() => {
    // If the active preview disappears (tab closed or switched away), don't keep the user on a dead Console/Network tab.
    if (activePreviewId) return;
    if (state.activeTab === "previewConsole" || state.activeTab === "previewNetwork") {
      onUpdate((prev) => ({ ...prev, activeTab: "terminal" }));
    }
  }, [activePreviewId, onUpdate, state.activeTab]);

  const visible = state.isVisible;
  const viewTerminals = useMemo(() => {
    const byId = new Map(state.terminals.map((t) => [t.id, t]));
    const ids = state.viewIds.length ? state.viewIds : state.terminals[0]?.id ? [state.terminals[0].id] : [];
    return ids.map((id) => byId.get(id) ?? null);
  }, [state.terminals, state.viewIds]);

  function createTerminal({ split }: { split: boolean }) {
    onUpdate((prev) => {
      const id = `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const title = `${t("terminalLabel")} ${prev.terminals.length + 1}`;
      const nextTerminals = [...prev.terminals, { id, title }];
      if (!prev.isVisible) {
        return { ...prev, isVisible: true, activeTab: "terminal", terminals: nextTerminals, viewIds: [id], focusedView: 0 };
      }
      if (!prev.viewIds.length) {
        return { ...prev, isVisible: true, activeTab: "terminal", terminals: nextTerminals, viewIds: [id], focusedView: 0 };
      }
      if (split && prev.viewIds.length < 3) {
        const nextViewIds = [...prev.viewIds, id];
        return { ...prev, isVisible: true, activeTab: "terminal", terminals: nextTerminals, viewIds: nextViewIds, focusedView: nextViewIds.length - 1 };
      }
      const idx = clamp(prev.focusedView, 0, prev.viewIds.length - 1);
      const nextViewIds = prev.viewIds.map((v, i) => (i === idx ? id : v));
      return { ...prev, isVisible: true, activeTab: "terminal", terminals: nextTerminals, viewIds: nextViewIds, focusedView: idx };
    });
  }

  function closeTerminal(id: string) {
    onUpdate((prev) => {
      const closing = prev.terminals.find((t) => t.id === id);
      if (closing?.sessionId) void window.xcoding.terminal.dispose(closing.sessionId);
      const nextTerminals = prev.terminals.filter((t) => t.id !== id);
      const nextViewIds = prev.viewIds.filter((v) => v !== id);
      if (nextTerminals.length === 0) return { ...prev, terminals: [], viewIds: [], isVisible: false, focusedView: 0 };
      if (nextViewIds.length === 0) {
        return { ...prev, terminals: nextTerminals, viewIds: [nextTerminals[0]?.id ?? ""].filter(Boolean), focusedView: 0 };
      }
      return { ...prev, terminals: nextTerminals, viewIds: nextViewIds, focusedView: clamp(prev.focusedView, 0, nextViewIds.length - 1) };
    });
  }

  function setActiveTab(next: PanelTabId) {
    onUpdate((prev) => ({ ...prev, isVisible: true, activeTab: next }));
  }

  function setFocusedView(index: number) {
    onUpdate((prev) => ({ ...prev, focusedView: clamp(index, 0, Math.max(0, prev.viewIds.length - 1)) }));
  }

  function showTerminalInFocusedView(id: string) {
    onUpdate((prev) => {
      if (!prev.viewIds.length) return prev;
      const idx = clamp(prev.focusedView, 0, prev.viewIds.length - 1);
      const next = prev.viewIds.map((v, i) => (i === idx ? id : v));
      return { ...prev, viewIds: next };
    });
  }

  function onDragStartTerminal(e: React.DragEvent, id: string) {
    draggingTerminalIdRef.current = id;
    e.dataTransfer.setData("application/x-xcoding-terminal-id", JSON.stringify({ id }));
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragOverTerminal(e: React.DragEvent, overId: string) {
    if (!e.dataTransfer.types.includes("application/x-xcoding-terminal-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const fromId = draggingTerminalIdRef.current;
    if (!fromId || fromId === overId) return;
    onUpdate((prev) => {
      const fromIdx = prev.terminals.findIndex((t) => t.id === fromId);
      const toIdx = prev.terminals.findIndex((t) => t.id === overId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const nextTerminals = [...prev.terminals];
      const [moved] = nextTerminals.splice(fromIdx, 1);
      nextTerminals.splice(toIdx, 0, moved);
      return { ...prev, terminals: nextTerminals };
    });
  }

  function onDragEndTerminal() {
    draggingTerminalIdRef.current = null;
  }

  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = state.height;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const next = clamp(startHeight - dy, 160, 720);
      onUpdate((p) => ({ ...p, height: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  if (!visible) return null;

  const activeTab: PanelTabId = state.activeTab ?? "terminal";
  const cols = Math.max(1, Math.min(3, viewTerminals.length || 1));

  const activeConsole = activePreviewId ? (consoleByPreviewIdRef.current[activePreviewId] ?? []) : [];
  const activeNetwork = activePreviewId ? (networkByPreviewIdRef.current[activePreviewId] ?? []) : [];

  function clearActivePreview(kind: "console" | "network") {
    if (!activePreviewId) return;
    if (kind === "console") consoleByPreviewIdRef.current[activePreviewId] = [];
    else networkByPreviewIdRef.current[activePreviewId] = [];
    scheduleRerender();
  }

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]" style={{ height: state.height }}>
      <div
        ref={resizerRef}
        className="h-1 w-full cursor-row-resize bg-transparent hover:bg-[var(--vscode-panel-border)]"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="horizontal"
      />

      <div className="group flex h-9 items-center justify-between border-b border-[var(--vscode-panel-border)] px-2">
        <div className="flex items-center gap-1">
          <button className={tabButtonClass(activeTab === "terminal")} onClick={() => setActiveTab("terminal")} type="button">
            {t("terminal")}
          </button>
          <button
            className={[tabButtonClass(activeTab === "previewConsole"), "disabled:cursor-not-allowed disabled:opacity-50"].join(" ")}
            disabled={!activePreviewId}
            onClick={() => setActiveTab("previewConsole")}
            type="button"
            title={activePreviewId ? t("previewConsole") : t("openPreviewTabFirst")}
          >
            {t("console")}
          </button>
          <button
            className={[tabButtonClass(activeTab === "previewNetwork"), "disabled:cursor-not-allowed disabled:opacity-50"].join(" ")}
            disabled={!activePreviewId}
            onClick={() => setActiveTab("previewNetwork")}
            type="button"
            title={activePreviewId ? t("previewNetwork") : t("openPreviewTabFirst")}
          >
            {t("network")}
          </button>
          {activePreviewUrl && (activeTab === "previewConsole" || activeTab === "previewNetwork") ? (
            <div className="ml-2 max-w-[42vw] truncate text-[11px] text-[var(--vscode-descriptionForeground)]" title={activePreviewUrl}>
              {activePreviewUrl}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {activeTab === "terminal" ? (
            <>
              <button
                className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                title={t("newTerminal")}
                onClick={() => createTerminal({ split: false })}
              >
                <Plus className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              title={t("clear")}
              disabled={!activePreviewId}
              onClick={() => clearActivePreview(activeTab === "previewNetwork" ? "network" : "console")}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            type="button"
            title={t("hidePanel")}
            onClick={() => onUpdate((p) => ({ ...p, isVisible: false }))}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {activeTab === "terminal" ? (
        state.terminals.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-[var(--vscode-descriptionForeground)]">
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-sm text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              type="button"
              onClick={() => createTerminal({ split: false })}
            >
              {t("newTerminal")}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 p-2">
              <div className="grid h-full min-h-0 gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {viewTerminals.map((term, index) => {
                  if (!term) return <div key={`empty-${index}`} className="h-full rounded border border-dashed border-[var(--vscode-panel-border)]" />;
                  const isActiveView = index === state.focusedView;
                  return (
                    <div
                      key={term.id}
                      className={[
                        "relative min-h-0 overflow-hidden rounded border border-[var(--vscode-panel-border)]",
                        // Avoid blue focus ring around the active terminal view.
                        ""
                      ].join(" ")}
                      onMouseDown={() => setFocusedView(index)}
                    >
                      <TerminalView
                        tabId={term.id}
                        sessionId={term.sessionId}
                        onSessionId={(sessionId) => {
                          onUpdate((prev) => ({
                            ...prev,
                            terminals: prev.terminals.map((t) => (t.id === term.id ? { ...t, sessionId } : t))
                          }));
                        }}
                        isActive
                        isPaused={false}
                        scrollback={scrollback}
                        slot={slot}
                        projectRootPath={projectRootPath}
                        onOpenUrl={onOpenUrl}
                        onOpenFile={onOpenFile}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="w-[180px] shrink-0 border-l border-[var(--vscode-panel-border)] p-1">
              {state.terminals.map((t) => {
                const isShown = state.viewIds.includes(t.id);
                const isFocused = state.viewIds[state.focusedView] === t.id;
                return (
                  <div
                    key={t.id}
                    className={[
                      "group flex items-center justify-between gap-2 rounded px-2 py-1 text-[11px]",
                      isFocused
                        ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                        : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                    ].join(" ")}
                    title={t.title}
                    onClick={() => showTerminalInFocusedView(t.id)}
                    draggable
                    onDragStart={(e) => onDragStartTerminal(e, t.id)}
                    onDragEnd={onDragEndTerminal}
                    onDragOver={(e) => onDragOverTerminal(e, t.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {t.title} {isShown ? <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">•</span> : null}
                    </span>
                    <button
                      className="invisible rounded px-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible disabled:opacity-50"
                      type="button"
                      title="Split Terminal"
                      disabled={state.viewIds.length >= 3}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveTab("terminal");
                        showTerminalInFocusedView(t.id);
                        createTerminal({ split: true });
                      }}
                    >
                      <SquareSplitHorizontal className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="invisible rounded px-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible"
                      type="button"
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminal(t.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2 text-[11px] text-[var(--vscode-foreground)]">
          {!activePreviewId ? (
            <div className="flex h-full items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">
              {t("openPreviewToSeeLogs")}
            </div>
          ) : activeTab === "previewNetwork" ? (
            activeNetwork.length === 0 ? (
              <div className="text-[var(--vscode-descriptionForeground)]">{t("noNetworkEntries")}</div>
            ) : (
              <div className="space-y-1">
                {activeNetwork.map((e) => (
                  <div key={e.requestId} className="truncate rounded px-2 py-1 hover:bg-[var(--vscode-list-hoverBackground)]" title={e.url}>
                    <span className="mr-2 text-[var(--vscode-descriptionForeground)]">{new Date(e.timestamp).toLocaleTimeString()}</span>
                    <span className="mr-2 text-[var(--vscode-descriptionForeground)]">{e.status}</span>
                    <span className="mr-2 text-[var(--vscode-descriptionForeground)]">{e.method}</span>
                    <span>{e.url}</span>
                  </div>
                ))}
              </div>
            )
          ) : activeConsole.length === 0 ? (
            <div className="text-[var(--vscode-descriptionForeground)]">{t("noConsoleMessages")}</div>
          ) : (
            <div className="space-y-1">
              {activeConsole.map((e, i) => (
                <div key={i} className="rounded px-2 py-1 hover:bg-[var(--vscode-list-hoverBackground)]">
                  <span className="mr-2 text-[var(--vscode-descriptionForeground)]">{new Date(e.timestamp).toLocaleTimeString()}</span>
                  <span className="mr-2 text-[var(--vscode-descriptionForeground)]">{e.level}</span>
                  <span className="whitespace-pre-wrap">{e.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
