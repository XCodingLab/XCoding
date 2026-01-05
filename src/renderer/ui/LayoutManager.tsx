import { type DragEvent, type MouseEvent, useMemo, useRef, useState } from "react";

export type PaneId = "A" | "B" | "C";

export type LayoutMode = "1x1" | "2x1" | "3x1" | "1x2";

type SplitRatios = {
  col: number; // 0..1
  col2: number; // 0..1 (only used in 3x1)
  row: number; // 0..1
};

type Props<TTab extends { id: string }> = {
  mode: LayoutMode;
  split: SplitRatios;
  activePane: PaneId;
  panes: Record<PaneId, { tabs: TTab[]; activeTabId: string }>;
  setSplit: (next: SplitRatios) => void;
  setActivePane: (pane: PaneId) => void;
  onActivateTab: (pane: PaneId, tabId: string) => void;
  onMoveTab: (fromPane: PaneId, toPane: PaneId, tabId: string, intent?: SplitIntent | null) => void;
  onDropFile?: (toPane: PaneId, relPath: string, intent?: SplitIntent | null) => void;
  onCloseTab?: (pane: PaneId, tabId: string) => void;
  onTabDragStateChange?: (dragging: boolean) => void;
  renderTabLabel: (tab: TTab) => string;
  renderTab: (pane: PaneId, tab: TTab) => React.ReactNode;
  renderEmpty?: (pane: PaneId) => React.ReactNode;
};

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function panesForMode(mode: LayoutMode) {
  if (mode === "1x1") return ["A"] as const;
  if (mode === "2x1") return ["A", "B"] as const;
  if (mode === "3x1") return ["A", "B", "C"] as const;
  return ["A", "C"] as const;
}

function dropPaneForPoint(mode: LayoutMode, point: { x: number; y: number }, rect: DOMRect, split: SplitRatios): PaneId {
  if (mode === "1x1") return "A";
  const relX = (point.x - rect.left) / rect.width;
  const relY = (point.y - rect.top) / rect.height;
  if (mode === "2x1") return relX < split.col ? "A" : "B";
  if (mode === "3x1") return relX < split.col ? "A" : relX < split.col2 ? "B" : "C";
  return relY < split.row ? "A" : "C";
}

export type SplitIntent = { mode: LayoutMode; pane: PaneId };

function splitIntent(mode: LayoutMode, point: { x: number; y: number }, rect: DOMRect): SplitIntent | null {
  const relX = (point.x - rect.left) / rect.width;
  const relY = (point.y - rect.top) / rect.height;
  const EDGE_2 = 0.25;
  const EDGE_3 = 0.12;

  if (mode === "1x1") {
    if (relX <= EDGE_2) return { mode: "2x1", pane: "A" };
    if (relX >= 1 - EDGE_2) return { mode: "2x1", pane: "B" };
    if (relY <= EDGE_2) return { mode: "1x2", pane: "A" };
    if (relY >= 1 - EDGE_2) return { mode: "1x2", pane: "C" };
    return null;
  }

  if (mode === "2x1") {
    if (relX >= 1 - EDGE_3) return { mode: "3x1", pane: "C" };
    return null;
  }

  return null;
}

export default function LayoutManager<TTab extends { id: string }>({
  mode,
  split,
  activePane,
  panes,
  setSplit,
  setActivePane,
  onActivateTab,
  onMoveTab,
  onDropFile,
  onCloseTab,
  onTabDragStateChange,
  renderTabLabel,
  renderTab,
  renderEmpty
}: Props<TTab>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef<null | "col" | "col2" | "row">(null);
  const [dragOverPane, setDragOverPane] = useState<PaneId | null>(null);
  const [dragIntent, setDragIntent] = useState<SplitIntent | null>(null);
  const splitRef = useRef(split);
  splitRef.current = split;

  const visiblePanes = useMemo(() => panesForMode(mode), [mode]);

  function startResize(which: "col" | "col2" | "row", e: MouseEvent) {
    e.preventDefault();
    resizingRef.current = which;
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!containerRef.current || !resizingRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const MIN = 0.15;
      const MAX_COL = 1 - MIN * 2; // keep room for a 3rd pane
      const MAX_COL2 = 1 - MIN;
      if (resizingRef.current === "col") {
        const relX = (ev.clientX - rect.left) / rect.width;
        const nextCol = clamp(relX, MIN, MAX_COL);
        const nextCol2 = clamp(splitRef.current.col2, nextCol + MIN, MAX_COL2);
        setSplit({ ...splitRef.current, col: nextCol, col2: nextCol2 });
      } else if (resizingRef.current === "col2") {
        const relX = (ev.clientX - rect.left) / rect.width;
        const nextCol2 = clamp(relX, splitRef.current.col + MIN, MAX_COL2);
        setSplit({ ...splitRef.current, col2: nextCol2 });
      } else if (resizingRef.current === "row") {
        const relY = (ev.clientY - rect.top) / rect.height;
        setSplit({ ...splitRef.current, row: clamp(relY, 0.2, 0.8) });
      }
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onDragStartTab(e: DragEvent, pane: PaneId, tabId: string) {
    onTabDragStateChange?.(true);
    e.dataTransfer.setData("application/x-xcoding-tab", JSON.stringify({ pane, tabId }));
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragEndTab() {
    onTabDragStateChange?.(false);
  }

  function onDragOverContainer(e: DragEvent) {
    if (!containerRef.current) return;
    const hasTab = e.dataTransfer.types.includes("application/x-xcoding-tab");
    const hasFile = e.dataTransfer.types.includes("application/x-xcoding-file");
    if (!hasTab && !hasFile) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const intent = splitIntent(mode, { x: e.clientX, y: e.clientY }, rect);
    if (intent) {
      setDragIntent(intent);
      setDragOverPane(null);
      return;
    }
    setDragIntent(null);
    setDragOverPane(dropPaneForPoint(mode, { x: e.clientX, y: e.clientY }, rect, split));
  }

  function onDragLeave() {
    setDragOverPane(null);
    setDragIntent(null);
  }

  function onDropContainer(e: DragEvent) {
    setDragOverPane(null);
    setDragIntent(null);
    onTabDragStateChange?.(false);
    if (!containerRef.current) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const intent = splitIntent(mode, { x: e.clientX, y: e.clientY }, rect);
    const toPane = intent ? intent.pane : dropPaneForPoint(mode, { x: e.clientX, y: e.clientY }, rect, split);

    const tabRaw = e.dataTransfer.getData("application/x-xcoding-tab");
    if (tabRaw) {
      const parsed = JSON.parse(tabRaw) as { pane: PaneId; tabId: string };
      onMoveTab(parsed.pane, toPane, parsed.tabId, intent);
      window.dispatchEvent(new CustomEvent("xcoding:tabMoved", { detail: { tabId: parsed.tabId, toPane } }));
      return;
    }

    const fileRaw = e.dataTransfer.getData("application/x-xcoding-file");
    if (fileRaw && onDropFile) {
      try {
        const parsed = JSON.parse(fileRaw) as { path?: string };
        const relPath = String(parsed?.path ?? "");
        if (relPath) onDropFile(toPane, relPath, intent);
      } catch {
        // ignore
      }
    }
  }

  const gridTemplateColumns =
    mode === "1x1" || mode === "1x2"
      ? "1fr"
      : mode === "2x1"
        ? `${Math.round(split.col * 100)}% ${Math.round((1 - split.col) * 100)}%`
        : `${Math.round(split.col * 100)}% ${Math.round((split.col2 - split.col) * 100)}% ${Math.round((1 - split.col2) * 100)}%`;
  const gridTemplateRows =
    mode === "1x1" || mode === "2x1" || mode === "3x1" ? "1fr" : `${Math.round(split.row * 100)}% ${Math.round((1 - split.row) * 100)}%`;

  function renderPaneCell(pane: PaneId) {
    const p = panes[pane];
    const effectiveActiveTabId = p.tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId : p.tabs[0]?.id ?? "";
    const highlight = dragOverPane === pane ? "ring-2 ring-amber-500" : "";
    const hasTabs = p.tabs.length > 0;
    return (
      <div
        key={pane}
        className={[
          "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]",
                  // Avoid VS Code-like blue focus ring around panes (too visually loud for this IDE).
                  "",
          highlight
        ].join(" ")}
        onMouseDown={() => setActivePane(pane)}
      >
        {hasTabs ? (
          <div className="flex h-9 items-center gap-1 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-tab-inactiveBackground)] px-2">
            {p.tabs.map((tab) => {
              const isActive = tab.id === effectiveActiveTabId;
              return (
                <div
                  key={tab.id}
                  draggable
                  onDragStart={(e) => onDragStartTab(e, pane, tab.id)}
                  onDragEnd={onDragEndTab}
                  className={[
                    "group flex max-w-[240px] items-center gap-1 rounded px-2 py-1",
                    isActive
                      ? "bg-[var(--vscode-tab-activeBackground)] text-[var(--vscode-tab-activeForeground)]"
                      : "text-[var(--vscode-tab-inactiveForeground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                  ].join(" ")}
                >
                  <button className="min-w-0 flex-1 truncate text-left text-xs" onClick={() => onActivateTab(pane, tab.id)} type="button">
                    {renderTabLabel(tab)}
                  </button>
                  {onCloseTab ? (
                    <button
                      className="hidden rounded px-1 text-[11px] text-[var(--vscode-tab-inactiveForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)] group-hover:block"
                      onClick={() => onCloseTab(pane, tab.id)}
                      type="button"
                      title="Close"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <div className={["relative min-h-0 flex-1", hasTabs ? "" : "p-2"].join(" ")}>
          {hasTabs ? (
            p.tabs.map((tab) => {
              const isActive = tab.id === effectiveActiveTabId;
              return (
                <div
                  key={`${pane}:${tab.id}`}
                  className={["absolute inset-0 min-h-0 p-2", isActive ? "opacity-100" : "pointer-events-none opacity-0"].join(" ")}
                >
                  {renderTab(pane, tab)}
                </div>
              );
            })
          ) : (
            <div className="flex h-full items-center justify-center rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-6 text-sm text-[var(--vscode-descriptionForeground)]">
              {renderEmpty ? renderEmpty(pane) : "Drop a tab or open a file to start."}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={containerRef} className="relative min-h-0 flex-1" onDragOver={onDragOverContainer} onDragLeave={onDragLeave} onDrop={onDropContainer}>
        <div className="grid h-full min-h-0 gap-2" style={{ gridTemplateColumns, gridTemplateRows }}>
          {visiblePanes.map((p) => renderPaneCell(p))}
        </div>

        {dragIntent ? (
          <div className="pointer-events-none absolute inset-0 z-20">
            <div
              className="absolute inset-0 rounded border border-[var(--vscode-focusBorder)] bg-[rgba(255,255,255,0.04)] transition-all duration-150"
              style={
                dragIntent.mode === "2x1"
                  ? dragIntent.pane === "A"
                    ? { right: "50%" }
                    : { left: "50%" }
                  : dragIntent.mode === "3x1"
                    ? { left: "66.666%" }
                    : dragIntent.pane === "A"
                      ? { bottom: "50%" }
                      : { top: "50%" }
              }
            />
          </div>
        ) : null}

        {mode === "2x1" ? (
          <div
            className="absolute bottom-0 top-0 z-10 w-2 cursor-col-resize"
            style={{ left: `calc(${Math.round(split.col * 100)}% - 4px)` }}
            onMouseDown={(e) => startResize("col", e)}
            role="separator"
            aria-orientation="vertical"
          />
        ) : null}
        {mode === "3x1" ? (
          <>
            <div
              className="absolute bottom-0 top-0 z-10 w-2 cursor-col-resize"
              style={{ left: `calc(${Math.round(split.col * 100)}% - 4px)` }}
              onMouseDown={(e) => startResize("col", e)}
              role="separator"
              aria-orientation="vertical"
            />
            <div
              className="absolute bottom-0 top-0 z-10 w-2 cursor-col-resize"
              style={{ left: `calc(${Math.round(split.col2 * 100)}% - 4px)` }}
              onMouseDown={(e) => startResize("col2", e)}
              role="separator"
              aria-orientation="vertical"
            />
          </>
        ) : null}
        {mode === "1x2" ? (
          <div
            className="absolute left-0 right-0 z-10 h-2 cursor-row-resize"
            style={{ top: `calc(${Math.round(split.row * 100)}% - 4px)` }}
            onMouseDown={(e) => startResize("row", e)}
            role="separator"
            aria-orientation="horizontal"
          />
        ) : null}
      </div>
    </div>
  );
}
