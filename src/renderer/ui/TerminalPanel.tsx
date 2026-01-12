import { ChevronDown, ChevronRight, MoreVertical, Plus, SquareSplitHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import TerminalView from "./TerminalView";
import { useI18n } from "./i18n";

export type TerminalEntry = { id: string; title: string; sessionId?: string; initialCommand?: string };

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
type PreviewNetworkEntry = {
  requestId: string;
  url: string;
  status: number;
  method: string;
  type: string;
  timestamp: number;
  durationMs: number | null;
  sizeBytes: number | null;
  errorText: string | null;
};

type PreviewNetworkState = { order: string[]; byId: Record<string, PreviewNetworkEntry> };
type PreviewNetworkDetails = {
  requestId: string;
  url: string;
  method: string;
  type: string;
  status: number;
  statusText: string;
  mimeType: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  sizeBytes: number;
  errorText: string;
  requestHeaders: Record<string, string>;
  requestPostData: string;
  responseHeaders: Record<string, string>;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function tabButtonClass(isActive: boolean) {
  return [
    "rounded-full px-3 py-1 text-[11px] font-medium transition-all border border-transparent",
    isActive
      ? "bg-glass-highlight text-glass-text border-glass-highlight shadow-[0_0_10px_var(--glass-shadow)]"
      : "text-glass-text-dim hover:bg-glass-highlight hover:text-glass-text"
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
  const networkByPreviewIdRef = useRef<Record<string, PreviewNetworkState>>({});
  const preserveLogByPreviewIdRef = useRef<Record<string, boolean>>({});
  const responseBodyByPreviewIdRef = useRef<Record<string, Record<string, { body: string; base64Encoded: boolean; sizeBytes: number; mimeType: string }>>>({});
  const logsRafRef = useRef<number | null>(null);
  const messageTimerRef = useRef<number | null>(null);
  const [, forceRerender] = useState(0);

  function scheduleRerender() {
    if (logsRafRef.current != null) return;
    logsRafRef.current = requestAnimationFrame(() => {
      logsRafRef.current = null;
      forceRerender((v) => v + 1);
    });
  }

  function showMessage(msg: string) {
    if (messageTimerRef.current != null) window.clearTimeout(messageTimerRef.current);
    messageTimerRef.current = window.setTimeout(() => {
      messageTimerRef.current = null;
      setMessage(null);
    }, 2200);
    setMessage(msg);
  }

  const [message, setMessage] = useState<string | null>(null);
  const [networkQuery, setNetworkQuery] = useState("");
  const [networkStatusFilter, setNetworkStatusFilter] = useState<"all" | "2xx" | "3xx" | "4xx" | "5xx" | "failed">("all");
  const [networkTypeFilter, setNetworkTypeFilter] = useState<string>("all");
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedRequestDetails, setSelectedRequestDetails] = useState<PreviewNetworkDetails | null>(null);
  const [networkMenu, setNetworkMenu] = useState<{ isOpen: boolean; x: number; y: number; requestId: string } | null>(null);
  const [networkDetailsMenuOpen, setNetworkDetailsMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState<{ request: boolean; response: boolean; body: boolean }>({ request: true, response: false, body: false });
  const [bodyState, setBodyState] = useState<{ status: "idle" | "loading" | "ready" | "error"; error?: string; body?: string; base64Encoded?: boolean }>(
    { status: "idle" }
  );
  const [consoleQuery, setConsoleQuery] = useState("");
  const [consoleLevel, setConsoleLevel] = useState<"all" | "error" | "warn" | "info" | "log">("all");

  const activePreviewIdRef = useRef<string | null>(activePreviewId);
  useEffect(() => {
    activePreviewIdRef.current = activePreviewId;
  }, [activePreviewId]);

  const selectedRequestIdRef = useRef<string | null>(selectedRequestId);
  useEffect(() => {
    selectedRequestIdRef.current = selectedRequestId;
  }, [selectedRequestId]);

  const detailsFetchTokenRef = useRef(0);
  const bodyFetchTokenRef = useRef(0);

  const networkDetailsMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const networkDetailsMenuRef = useRef<HTMLDivElement | null>(null);

  // Close details menu on outside click.
  useEffect(() => {
    if (!networkDetailsMenuOpen) return;
    const onDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (networkDetailsMenuButtonRef.current && networkDetailsMenuButtonRef.current.contains(target)) return;
      if (networkDetailsMenuRef.current && networkDetailsMenuRef.current.contains(target)) return;
      setNetworkDetailsMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [networkDetailsMenuOpen]);

  useEffect(() => {
    return () => {
      if (messageTimerRef.current != null) window.clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    };
  }, []);

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
      const current = networkByPreviewIdRef.current[previewId] ?? { order: [], byId: {} };
      networkByPreviewIdRef.current[previewId] = current;

      const requestId = String(e.requestId ?? "");
      if (!requestId) return;
      const existing = current.byId[requestId];
      if (!existing) current.order.push(requestId);
      current.byId[requestId] = {
        requestId,
        url: String(e.url ?? existing?.url ?? ""),
        status: Number(e.status ?? existing?.status ?? 0),
        method: String(e.method ?? existing?.method ?? ""),
        type: String(e.type ?? existing?.type ?? ""),
        timestamp: Number(e.timestamp ?? existing?.timestamp ?? Date.now()),
        durationMs: e.durationMs ?? existing?.durationMs ?? null,
        sizeBytes: e.sizeBytes ?? existing?.sizeBytes ?? null,
        errorText: e.errorText ?? existing?.errorText ?? null
      };

      if (current.order.length > 200) {
        const evict = current.order.splice(0, current.order.length - 200);
        evict.forEach((id) => delete current.byId[id]);
      }
      scheduleRerender();
    });

    const offReset = window.xcoding.preview.onResetLogs((e) => {
      const previewId = String(e.previewId ?? "");
      if (!previewId) return;
      delete consoleByPreviewIdRef.current[previewId];
      delete networkByPreviewIdRef.current[previewId];
      preserveLogByPreviewIdRef.current[previewId] = false;
      delete responseBodyByPreviewIdRef.current[previewId];
      scheduleRerender();
    });

    return () => {
      offConsole();
      offNetwork();
      offReset();
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
    const preserves = preserveLogByPreviewIdRef.current;
    for (const id of Object.keys(preserves)) {
      if (!keep.has(id)) delete preserves[id];
    }
    const bodies = responseBodyByPreviewIdRef.current;
    for (const id of Object.keys(bodies)) {
      if (!keep.has(id)) delete bodies[id];
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

  function clearActivePreview(kind: "console" | "network") {
    if (!activePreviewId) return;
    if (kind === "console") consoleByPreviewIdRef.current[activePreviewId] = [];
    else networkByPreviewIdRef.current[activePreviewId] = { order: [], byId: {} };
    scheduleRerender();
  }

  const preserveLog = activePreviewId ? preserveLogByPreviewIdRef.current[activePreviewId] ?? false : false;

  async function setPreserveLog(next: boolean) {
    if (!activePreviewId) return;
    preserveLogByPreviewIdRef.current[activePreviewId] = next;
    scheduleRerender();
    try {
      await window.xcoding.preview.setPreserveLog({ previewId: activePreviewId, preserveLog: next });
    } catch {
      // ignore
    }
  }

  function formatBytes(bytes: number | null) {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  }

  function statusBadgeClass(status: number, errorText: string | null) {
    if (errorText) return "text-red-400";
    if (status >= 500) return "text-red-400";
    if (status >= 400) return "text-yellow-400";
    if (status >= 300) return "text-blue-400";
    if (status >= 200) return "text-green-400";
    return "text-[var(--vscode-descriptionForeground)]";
  }

  async function copyText(text: string) {
    const res = await window.xcoding.os.copyText(text);
    if (res.ok) showMessage(t("copied"));
    else showMessage(res.reason ? `${t("copyFailed")}: ${res.reason}` : t("copyFailed"));
  }

  async function copyCurl(requestId: string) {
    if (!activePreviewId) return;
    const res = await window.xcoding.preview.networkBuildCurl({ previewId: activePreviewId, requestId });
    if (!res.ok) {
      showMessage(res.reason ? `${t("copyFailed")}: ${res.reason}` : t("copyFailed"));
      return;
    }
    await copyText(res.curl);
  }

  async function copyResponseBody(requestId: string) {
    if (!activePreviewId) return;
    const res = await window.xcoding.preview.networkGetResponseBody({ previewId: activePreviewId, requestId });
    if (!res.ok) {
      if (res.reason === "too_large") showMessage(t("responseTooLarge"));
      else showMessage(res.reason ? `${t("copyFailed")}: ${res.reason}` : t("copyFailed"));
      return;
    }
    await copyText(res.body);
  }

  async function clearBrowserCache() {
    if (!activePreviewId) return;
    const res = await window.xcoding.preview.networkClearBrowserCache({ previewId: activePreviewId });
    if (res.ok) showMessage(t("cacheCleared"));
    else showMessage(res.reason ? `${t("actionFailed")}: ${res.reason}` : t("actionFailed"));
  }

  async function ensureResponseBodyLoaded(requestId: string) {
    const previewId = activePreviewIdRef.current;
    if (!previewId) return;
    if (selectedRequestIdRef.current !== requestId) return;

    const cache = responseBodyByPreviewIdRef.current[previewId] ?? {};
    responseBodyByPreviewIdRef.current[previewId] = cache;
    const existing = cache[requestId];
    if (existing) {
      setBodyState({ status: "ready", body: existing.body, base64Encoded: existing.base64Encoded });
      return;
    }

    const token = (bodyFetchTokenRef.current += 1);
    setBodyState({ status: "loading" });
    const res = await window.xcoding.preview.networkGetResponseBody({ previewId, requestId });
    if (bodyFetchTokenRef.current !== token) return;
    if (activePreviewIdRef.current !== previewId) return;
    if (selectedRequestIdRef.current !== requestId) return;
    if (!res.ok) {
      const reason = res.reason === "too_large" ? t("responseTooLarge") : res.reason || t("actionFailed");
      setBodyState({ status: "error", error: reason });
      return;
    }
    cache[requestId] = { body: res.body, base64Encoded: res.base64Encoded, sizeBytes: res.sizeBytes, mimeType: res.mimeType };
    setBodyState({ status: "ready", body: res.body, base64Encoded: res.base64Encoded });

    // If body exists, default to focusing on body.
    if (res.body && res.body.length) {
      setDetailsOpen({ request: false, response: false, body: true });
    }
  }

  async function loadSelectedRequestDetails(requestId: string) {
    const previewId = activePreviewIdRef.current;
    if (!previewId) return;
    const token = (detailsFetchTokenRef.current += 1);
    const res = await window.xcoding.preview.networkGetEntry({ previewId, requestId });
    if (detailsFetchTokenRef.current !== token) return;
    if (activePreviewIdRef.current !== previewId) return;
    if (selectedRequestIdRef.current !== requestId) return;
    if (!res.ok) {
      setSelectedRequestDetails(null);
      return;
    }
    setSelectedRequestDetails(res.entry);
  }

  useEffect(() => {
    setSelectedRequestId(null);
    setSelectedRequestDetails(null);
    setNetworkMenu(null);
    setNetworkDetailsMenuOpen(false);
    setDetailsOpen({ request: true, response: false, body: false });
    setBodyState({ status: "idle" });
  }, [activePreviewId]);

  useEffect(() => {
    if (!selectedRequestId) return;
    void loadSelectedRequestDetails(selectedRequestId);
    setNetworkDetailsMenuOpen(false);
    setDetailsOpen({ request: true, response: false, body: false });
    setBodyState({ status: "idle" });
  }, [selectedRequestId]);

  useEffect(() => {
    if (!selectedRequestDetails) return;
    if (!selectedRequestId) return;
    if (selectedRequestDetails.requestId !== selectedRequestId) return;
    // Default behavior:
    // - if body exists: collapse headers and expand body
    // - else: keep request headers expanded (response collapsed)
    if (selectedRequestDetails.sizeBytes > 0) void ensureResponseBodyLoaded(selectedRequestId);
  }, [selectedRequestDetails, selectedRequestId]);

  if (!visible) return null;

  const activeTab: PanelTabId = state.activeTab ?? "terminal";
  const cols = Math.max(1, Math.min(3, viewTerminals.length || 1));

  const activeConsole = activePreviewId ? (consoleByPreviewIdRef.current[activePreviewId] ?? []) : [];
  const activeNetworkState = activePreviewId ? (networkByPreviewIdRef.current[activePreviewId] ?? { order: [], byId: {} }) : { order: [], byId: {} };
  const activeNetwork: PreviewNetworkEntry[] = activeNetworkState.order.map((id) => activeNetworkState.byId[id]).filter(Boolean);

  return (
    <div className="flex min-h-0 shrink-0 flex-col bg-glass-bg backdrop-blur-md border-t border-glass-border" style={{ height: state.height }}>
      <div
        ref={resizerRef}
        className="h-1 w-full cursor-row-resize bg-glass-highlight hover:bg-brand-primary/50 transition-colors"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="horizontal"
      />

      <div className="group flex h-10 items-center justify-between px-3">
        <div className="flex items-center gap-2">
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

          {activeTab === "previewConsole" ? (
            <>
              <span className="mx-1 text-[var(--vscode-descriptionForeground)]">|</span>
              <input
                className="h-7 w-[220px] rounded bg-[var(--vscode-input-background)] px-2 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                placeholder={t("filterConsolePlaceholder")}
                value={consoleQuery}
                onChange={(e) => setConsoleQuery(e.target.value)}
              />
              <select
                className="h-7 rounded bg-[var(--vscode-input-background)] px-2 text-[12px] text-[var(--vscode-input-foreground)] ring-1 ring-[var(--vscode-input-border)]"
                value={consoleLevel}
                onChange={(e) => setConsoleLevel(e.target.value as any)}
              >
                <option value="all">{t("all")}</option>
                <option value="error">error</option>
                <option value="warn">warn</option>
                <option value="info">info</option>
                <option value="log">log</option>
              </select>
              <button
                className={[
                  "rounded px-2 py-1 text-[11px]",
                  preserveLog
                    ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                    : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                ].join(" ")}
                type="button"
                onClick={() => void setPreserveLog(!preserveLog)}
                title={t("preserveLog")}
              >
                {t("preserveLog")}
              </button>
            </>
          ) : null}

          {activeTab === "previewNetwork" ? (
            <>
              <span className="mx-1 text-[var(--vscode-descriptionForeground)]">|</span>
              <input
                className="h-7 w-[260px] rounded bg-[var(--vscode-input-background)] px-2 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                placeholder={t("filterUrlPlaceholder")}
                value={networkQuery}
                onChange={(e) => setNetworkQuery(e.target.value)}
              />
              <select
                className="h-7 rounded bg-[var(--vscode-input-background)] px-2 text-[12px] text-[var(--vscode-input-foreground)] ring-1 ring-[var(--vscode-input-border)]"
                value={networkStatusFilter}
                onChange={(e) => setNetworkStatusFilter(e.target.value as any)}
              >
                <option value="all">{t("all")}</option>
                <option value="2xx">2xx</option>
                <option value="3xx">3xx</option>
                <option value="4xx">4xx</option>
                <option value="5xx">5xx</option>
                <option value="failed">{t("failed")}</option>
              </select>
              <select
                className="h-7 rounded bg-[var(--vscode-input-background)] px-2 text-[12px] text-[var(--vscode-input-foreground)] ring-1 ring-[var(--vscode-input-border)]"
                value={networkTypeFilter}
                onChange={(e) => setNetworkTypeFilter(e.target.value)}
              >
                <option value="all">{t("all")}</option>
                {Array.from(new Set(activeNetwork.map((e) => e.type).filter(Boolean)))
                  .sort((a, b) => a.localeCompare(b))
                  .map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
              </select>
              <button
                className={[
                  "rounded px-2 py-1 text-[11px]",
                  preserveLog
                    ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                    : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                ].join(" ")}
                type="button"
                onClick={() => void setPreserveLog(!preserveLog)}
                title={t("preserveLog")}
              >
                {t("preserveLog")}
              </button>
              <button
                className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                type="button"
                onClick={() => void clearBrowserCache()}
                title={t("clearCache")}
              >
                {t("clearCache")}
              </button>
            </>
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
	                  const isFocusedView = index === state.focusedView;
	                  return (
	                    <div
	                      key={term.id}
	                      className={[
	                        "relative min-h-0 overflow-hidden bg-glass-bg-heavy rounded-md border border-glass-border",
	                        isFocusedView ? "ring-1 ring-brand-primary/50" : ""
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
                        initialCommand={term.initialCommand}
                        onDidRunInitialCommand={() => {
                          onUpdate((prev) => ({
                            ...prev,
                            terminals: prev.terminals.map((t) => (t.id === term.id ? { ...t, initialCommand: undefined } : t))
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

            <div className="w-[180px] shrink-0 bg-transparent p-2 border-l border-glass-border">
              {state.terminals.map((t) => {
                const isShown = state.viewIds.includes(t.id);
                const isFocused = state.viewIds[state.focusedView] === t.id;
                return (
                  <div
                    key={t.id}
                    className={[
                      "group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[11px] transition-all",
                      isFocused
                        ? "bg-glass-highlight text-glass-text font-medium shadow-sm"
                        : "text-glass-text-dim hover:bg-glass-highlight hover:text-glass-text"
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
        <div className="relative flex min-h-0 flex-1 flex-col text-[11px] text-[var(--vscode-foreground)]" onClick={() => setNetworkMenu(null)}>
          {!activePreviewId ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">
              {t("openPreviewToSeeLogs")}
            </div>
          ) : activeTab === "previewNetwork" ? (
            <>
              <div className="flex min-h-0 flex-1">
                <div className="min-h-0 flex-1 overflow-auto">
                  {(() => {
                    const q = networkQuery.trim().toLowerCase();
                    const filtered = activeNetwork.filter((e) => {
                      if (q && !String(e.url ?? "").toLowerCase().includes(q)) return false;
                      if (networkStatusFilter === "failed" && !(Boolean(e.errorText) || e.status === 0)) return false;
                      if (networkStatusFilter === "2xx" && !(e.status >= 200 && e.status < 300)) return false;
                      if (networkStatusFilter === "3xx" && !(e.status >= 300 && e.status < 400)) return false;
                      if (networkStatusFilter === "4xx" && !(e.status >= 400 && e.status < 500)) return false;
                      if (networkStatusFilter === "5xx" && !(e.status >= 500 && e.status < 600)) return false;
                      if (networkTypeFilter !== "all" && networkTypeFilter && e.type !== networkTypeFilter) return false;
                      return true;
                    });

                    if (filtered.length === 0) {
                      return <div className="p-3 text-[var(--vscode-descriptionForeground)]">{t("noNetworkEntries")}</div>;
                    }

                    return (
                      <table className="w-full table-fixed border-separate border-spacing-0">
                        <thead className="sticky top-0 z-10 bg-[var(--vscode-editor-background)] text-[10px] text-[var(--vscode-descriptionForeground)]">
                          <tr>
                            <th className="w-[64px] px-2 py-1 text-left">{t("status")}</th>
                            <th className="w-[56px] px-2 py-1 text-left">{t("method")}</th>
                            <th className="w-[72px] px-2 py-1 text-left">{t("type")}</th>
                            <th className="w-[84px] px-2 py-1 text-left">{t("time")}</th>
                            <th className="w-[84px] px-2 py-1 text-left">{t("size")}</th>
                            <th className="px-2 py-1 text-left">{t("url")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((e) => {
                            const isSelected = e.requestId === selectedRequestId;
                            const statusLabel = e.errorText ? "ERR" : e.status ? String(e.status) : "…";
                            const durationLabel = typeof e.durationMs === "number" ? `${Math.round(e.durationMs)} ms` : "";
                            const sizeLabel = formatBytes(e.sizeBytes);
                            return (
                              <tr
                                key={e.requestId}
                                className={[
                                  "cursor-default",
                                  isSelected ? "bg-[var(--vscode-list-activeSelectionBackground)]" : "hover:bg-[var(--vscode-list-hoverBackground)]"
                                ].join(" ")}
                                onClick={() => {
                                  setSelectedRequestId(e.requestId);
                                  setNetworkMenu(null);
                                }}
                                onContextMenu={(ev) => {
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  setSelectedRequestId(e.requestId);
                                  setNetworkMenu({ isOpen: true, x: ev.clientX, y: ev.clientY, requestId: e.requestId });
                                }}
                                title={e.url}
                              >
                                <td className={["px-2 py-1", statusBadgeClass(e.status, e.errorText)].join(" ")}>{statusLabel}</td>
                                <td className="truncate px-2 py-1 text-[var(--vscode-descriptionForeground)]">{e.method}</td>
                                <td className="truncate px-2 py-1 text-[var(--vscode-descriptionForeground)]">{e.type}</td>
                                <td className="truncate px-2 py-1 text-[var(--vscode-descriptionForeground)]">{durationLabel}</td>
                                <td className="truncate px-2 py-1 text-[var(--vscode-descriptionForeground)]">{sizeLabel}</td>
                                <td className="truncate px-2 py-1">{e.url}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>

                <div className="hidden w-[360px] shrink-0 flex-col border-l border-[var(--vscode-panel-border)] lg:flex">
                  {!selectedRequestId ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-[var(--vscode-descriptionForeground)]">
                      {t("selectRequestToSeeDetails")}
                    </div>
                  ) : !selectedRequestDetails || selectedRequestDetails.requestId !== selectedRequestId ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-[var(--vscode-descriptionForeground)]">{t("loading")}</div>
                  ) : (
                    <>
                      <div className="relative flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] p-2">
                        <div className="min-w-0">
                          <div className="truncate text-[12px] text-[var(--vscode-foreground)]" title={selectedRequestDetails.url}>
                            {selectedRequestDetails.method}{" "}
                            <span className={statusBadgeClass(selectedRequestDetails.status, selectedRequestDetails.errorText || null)}>
                              {selectedRequestDetails.status || (selectedRequestDetails.errorText ? "ERR" : "…")}
                            </span>{" "}
                            {selectedRequestDetails.url}
                          </div>
                          <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                            {selectedRequestDetails.type}
                            {selectedRequestDetails.durationMs ? ` • ${Math.round(selectedRequestDetails.durationMs)} ms` : ""}
                            {selectedRequestDetails.sizeBytes ? ` • ${formatBytes(selectedRequestDetails.sizeBytes)}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                            type="button"
                            title={t("actions")}
                            ref={networkDetailsMenuButtonRef}
                            onClick={() => setNetworkDetailsMenuOpen((v) => !v)}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </div>

                        {networkDetailsMenuOpen ? (
                          <div
                            ref={networkDetailsMenuRef}
                            className="absolute right-2 top-9 z-20 min-w-[180px] rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-1 text-[11px] text-[var(--vscode-foreground)] shadow"
                          >
                            <button
                              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                              type="button"
                              onClick={() => {
                                setNetworkDetailsMenuOpen(false);
                                void copyText(selectedRequestDetails.url);
                              }}
                            >
                              {t("copyUrl")}
                            </button>
                            <button
                              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                              type="button"
                              onClick={() => {
                                setNetworkDetailsMenuOpen(false);
                                void copyCurl(selectedRequestId);
                              }}
                            >
                              {t("copyCurl")}
                            </button>
                            <button
                              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                              type="button"
                              onClick={() => {
                                setNetworkDetailsMenuOpen(false);
                                void copyResponseBody(selectedRequestId);
                              }}
                            >
                              {t("copyResponseBody")}
                            </button>
                          </div>
                        ) : null}
                      </div>

                      <div className="min-h-0 flex-1 overflow-auto p-2">
                        {selectedRequestDetails.errorText ? (
                          <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-300">
                            {selectedRequestDetails.errorText}
                          </div>
                        ) : null}

                        <button
                          className="mb-1 flex w-full items-center justify-between rounded px-1 py-1 text-left text-[11px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                          type="button"
                          onClick={() => setDetailsOpen((p) => ({ ...p, request: !p.request }))}
                        >
                          <span className="flex items-center gap-1">
                            {detailsOpen.request ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            <span>{t("requestHeaders")}</span>
                          </span>
                        </button>
                        {detailsOpen.request ? (
                          <pre className="mb-3 whitespace-pre-wrap break-all rounded bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-foreground)]">
                            {Object.keys(selectedRequestDetails.requestHeaders ?? {})
                              .sort((a, b) => a.localeCompare(b))
                              .map((k) => `${k}: ${(selectedRequestDetails.requestHeaders as any)[k]}`)
                              .join("\n") || t("noHeaders")}
                          </pre>
                        ) : null}

                        <button
                          className="mb-1 flex w-full items-center justify-between rounded px-1 py-1 text-left text-[11px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                          type="button"
                          onClick={() => setDetailsOpen((p) => ({ ...p, response: !p.response }))}
                        >
                          <span className="flex items-center gap-1">
                            {detailsOpen.response ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            <span>{t("responseHeaders")}</span>
                          </span>
                        </button>
                        {detailsOpen.response ? (
                          <pre className="mb-3 whitespace-pre-wrap break-all rounded bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-foreground)]">
                            {Object.keys(selectedRequestDetails.responseHeaders ?? {})
                              .sort((a, b) => a.localeCompare(b))
                              .map((k) => `${k}: ${(selectedRequestDetails.responseHeaders as any)[k]}`)
                              .join("\n") || t("noHeaders")}
                          </pre>
                        ) : null}

                        <button
                          className="mb-1 flex w-full items-center justify-between rounded px-1 py-1 text-left text-[11px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                          type="button"
                          onClick={() => {
                            const nextOpen = !detailsOpen.body;
                            setDetailsOpen((p) => ({ ...p, body: nextOpen }));
                            if (nextOpen) void ensureResponseBodyLoaded(selectedRequestId);
                          }}
                        >
                          <span className="flex items-center gap-1">
                            {detailsOpen.body ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            <span>{t("responseBody")}</span>
                          </span>
                        </button>
                        {detailsOpen.body ? (
                          bodyState.status === "loading" ? (
                            <div className="mb-3 rounded bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
                              {t("loading")}
                            </div>
                          ) : bodyState.status === "error" ? (
                            <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-2 text-[10px] text-red-300">{bodyState.error}</div>
                          ) : bodyState.status === "ready" ? (
                            bodyState.body ? (
                              <pre className="mb-3 whitespace-pre-wrap break-all rounded bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-foreground)]">
                                {bodyState.body}
                              </pre>
                            ) : (
                              <div className="mb-3 rounded bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
                                {t("noResponseBody")}
                              </div>
                            )
                          ) : (
                            <div className="mb-3 rounded bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
                              {t("noResponseBody")}
                            </div>
                          )
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {(() => {
                  const q = consoleQuery.trim().toLowerCase();
                  const normalize = (level: string) => {
                    const l = String(level ?? "").toLowerCase();
                    if (l === "warning") return "warn";
                    if (l === "debug") return "log";
                    if (l === "verbose") return "log";
                    return l || "log";
                  };
                  const filtered = activeConsole.filter((e) => {
                    const lvl = normalize(e.level);
                    if (consoleLevel !== "all" && lvl !== consoleLevel) return false;
                    if (!q) return true;
                    return String(e.text ?? "").toLowerCase().includes(q);
                  });
                  if (filtered.length === 0) return <div className="text-[var(--vscode-descriptionForeground)]">{t("noConsoleMessages")}</div>;
                  return (
                    <div className="space-y-1">
                      {filtered.map((e, i) => {
                        const lvl = normalize(e.level);
                        const lvlColor =
                          lvl === "error"
                            ? "text-red-400"
                            : lvl === "warn"
                              ? "text-yellow-400"
                              : lvl === "info"
                                ? "text-blue-400"
                                : "text-[var(--vscode-descriptionForeground)]";
                        return (
                          <div key={i} className="group flex items-start gap-2 rounded px-2 py-1 hover:bg-[var(--vscode-list-hoverBackground)]">
                            <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">
                              {new Date(e.timestamp).toLocaleTimeString()}
                            </span>
                            <span className={["shrink-0 text-[10px]", lvlColor].join(" ")}>{lvl}</span>
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.text}</span>
                            <button
                              className="invisible shrink-0 rounded px-2 py-0.5 text-[10px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible"
                              type="button"
                              onClick={() => void copyText(e.text)}
                            >
                              {t("copy")}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </>
          )}

          {message ? (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/40 px-2 py-1 text-[11px] text-white">{message}</div>
          ) : null}

          {activeTab === "previewNetwork" && networkMenu?.isOpen ? (
            <div
              className="fixed z-50 min-w-[180px] rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-1 text-[11px] text-[var(--vscode-foreground)] shadow"
              style={{ left: networkMenu.x, top: networkMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                onClick={() => {
                  const entry = activeNetworkState.byId[networkMenu.requestId];
                  setNetworkMenu(null);
                  if (entry?.url) void copyText(entry.url);
                }}
              >
                {t("copyUrl")}
              </button>
              <button
                className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                onClick={() => {
                  const requestId = networkMenu.requestId;
                  setNetworkMenu(null);
                  void copyCurl(requestId);
                }}
              >
                {t("copyCurl")}
              </button>
              <button
                className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                onClick={() => {
                  const requestId = networkMenu.requestId;
                  setNetworkMenu(null);
                  void copyResponseBody(requestId);
                }}
              >
                {t("copyResponseBody")}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
