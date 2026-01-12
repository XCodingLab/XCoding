import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import ExplorerTree from "./ExplorerTree";
import { useI18n } from "./i18n";
import SearchPreviewPanel from "./SearchPreviewPanel";

type Props = {
  slot: number;
  projectId?: string;
  rootPath?: string;
  isBound: boolean;
  width?: number;
  onOpenFile: (relPath: string, line?: number, column?: number) => void;
  onOpenGitDiff?: (relPath: string, mode: "working" | "staged") => void;
  onOpenFolder: () => void;
  onDeletedPaths?: (paths: string[]) => void;
};

type SearchMode = "files" | "content";

type FileSearchResult = { path: string; name: string; relativePath: string; score: number };
type ContentSearchMatch = { path: string; relativePath: string; line: number; column: number; content: string };
type ContentSearchResult = { matches: ContentSearchMatch[]; totalMatches: number; totalFiles: number; truncated: boolean };

type ContentLineResult = { relativePath: string; line: number; column: number; content: string; matchCount: number };
type ContentFileGroup = { relativePath: string; matchCount: number; lines: Array<ContentLineResult & { index: number }> };
type ContentIndex = { files: ContentFileGroup[]; flat: ContentLineResult[] };

type SearchState = {
  mode: SearchMode;
  query: string;
  fileResults: FileSearchResult[];
  contentResults: ContentSearchResult | null;
  selectedIndex: number;
  loading: boolean;
  error?: string;
  dividerY: number;
};

function buildContentIndex(result: ContentSearchResult | null): ContentIndex {
  const matches = result?.matches ?? [];
  if (!matches.length) return { files: [], flat: [] };

  const byFile = new Map<string, { matchCount: number; byLine: Map<number, ContentLineResult> }>();
  for (const m of matches) {
    const relativePath = String(m.relativePath ?? "");
    const line = Number(m.line ?? 0);
    if (!relativePath || line <= 0) continue;
    const column = Math.max(1, Number(m.column ?? 1));
    const content = String(m.content ?? "");

    const file = byFile.get(relativePath) ?? { matchCount: 0, byLine: new Map() };
    file.matchCount += 1;
    const existing = file.byLine.get(line);
    if (!existing) {
      file.byLine.set(line, { relativePath, line, column, content, matchCount: 1 });
    } else {
      existing.matchCount += 1;
      if (column < existing.column) existing.column = column;
    }
    if (!byFile.has(relativePath)) byFile.set(relativePath, file);
  }

  const flat: ContentLineResult[] = [];
  const files: ContentFileGroup[] = [];
  const sortedFiles = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [relativePath, file] of sortedFiles) {
    const lines = [...file.byLine.values()].sort((a, b) => a.line - b.line);
    const linesWithIndex = lines.map((l) => {
      const index = flat.length;
      flat.push(l);
      return { ...l, index };
    });
    files.push({ relativePath, matchCount: file.matchCount, lines: linesWithIndex });
  }

  return { files, flat };
}

export default function ExplorerPanel({ slot, projectId, rootPath, isBound, width, onOpenFile, onOpenGitDiff, onOpenFolder, onDeletedPaths }: Props) {
  const { t } = useI18n();
  const [activeView, setActiveView] = useState<"explorer" | "search">("explorer");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  const [search, setSearch] = useState<SearchState>(() => ({
    mode: "files",
    query: "",
    fileResults: [],
    contentResults: null,
    selectedIndex: 0,
    loading: false,
    dividerY: 55
  }));

  const debounceTimerRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setActiveView("explorer");
    setSearch({
      mode: "files",
      query: "",
      fileResults: [],
      contentResults: null,
      selectedIndex: 0,
      loading: false,
      dividerY: 55
    });
  }, [slot]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slot?: number; mode?: SearchMode } | undefined;
      if (!detail || detail.slot !== slot) return;
      setActiveView("search");
      setSearch((prev) => ({ ...prev, mode: detail.mode === "content" ? "content" : "files" }));
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    window.addEventListener("xcoding:openSearch", handler as any);
    return () => window.removeEventListener("xcoding:openSearch", handler as any);
  }, [slot]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slot?: number } | undefined;
      if (!detail || detail.slot !== slot) return;
      setActiveView("explorer");
    };
    window.addEventListener("xcoding:revealInExplorer", handler as any);
    return () => window.removeEventListener("xcoding:revealInExplorer", handler as any);
  }, [slot]);

  useEffect(() => {
    if (!isBound || activeView !== "search") return;
    const q = search.query.trim();
    if (!q) {
      setSearch((s) => ({ ...s, loading: false, error: undefined, fileResults: [], contentResults: null, selectedIndex: 0 }));
      return;
    }

    if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    const seq = (requestSeqRef.current += 1);
    debounceTimerRef.current = window.setTimeout(() => {
      setSearch((s) => ({ ...s, loading: true, error: undefined }));
      if (search.mode === "files") {
        void window.xcoding.project
          .searchFiles({ slot, query: q, maxResults: 120 })
          .then((res) => {
            if (requestSeqRef.current !== seq) return;
            if (!res.ok) {
              setSearch((s) => ({ ...s, loading: false, error: res.reason ?? "search_failed" }));
              return;
            }
            setSearch((s) => ({ ...s, loading: false, error: undefined, fileResults: res.results ?? [], contentResults: null, selectedIndex: 0 }));
          })
          .catch((e) => {
            if (requestSeqRef.current !== seq) return;
            setSearch((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
          });
        return;
      }

      void window.xcoding.project
        .searchContent({
          slot,
          query: q,
          maxResults: 600
        })
        .then((res) => {
          if (requestSeqRef.current !== seq) return;
          if (!res.ok) {
            setSearch((s) => ({ ...s, loading: false, error: res.reason ?? "search_failed" }));
            return;
          }
          setSearch((s) => ({ ...s, loading: false, error: undefined, fileResults: [], contentResults: res.result ?? null, selectedIndex: 0 }));
        })
        .catch((e) => {
          if (requestSeqRef.current !== seq) return;
          setSearch((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
        });
    }, 180);
    return () => {
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    };
  }, [activeView, isBound, search.mode, search.query, slot]);

  const contentIndex = useMemo(() => buildContentIndex(search.contentResults), [search.contentResults]);

  const selectedItem = useMemo(() => {
    if (search.mode === "files") return search.fileResults[search.selectedIndex] ?? null;
    return contentIndex.flat[search.selectedIndex] ?? null;
  }, [contentIndex.flat, search.fileResults, search.mode, search.selectedIndex]);

  function openSelected() {
    if (!selectedItem) return;
    if ("score" in selectedItem) {
      onOpenFile(selectedItem.relativePath);
      return;
    }
    onOpenFile(selectedItem.relativePath, selectedItem.line, selectedItem.column);
  }

  function handleDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const start = search.dividerY;
    const container = (e.currentTarget as HTMLElement).closest("[data-search-container]") as HTMLElement | null;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      const next = Math.max(20, Math.min(80, start + (delta / rect.height) * 100));
      setSearch((s) => ({ ...s, dividerY: next }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <aside
      className="flex h-full min-h-0 shrink-0 flex-col bg-transparent"
      style={width ? ({ width } as React.CSSProperties) : undefined}
    >
      {!isBound ? (
        <div className="p-3">
          <button
            className="w-full rounded bg-[var(--vscode-button-background)] px-3 py-2 text-sm text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
            onClick={onOpenFolder}
            type="button"
          >
            {t("openFolder")}
          </button>
          <div className="mt-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("explorerUnbound")}</div>
        </div>
      ) : null}

      {isBound ? (
        <div ref={searchContainerRef} className="p-3">
          <div className="flex items-center gap-2 rounded-md bg-[var(--vscode-input-background)] px-3 py-1.5 ring-1 ring-surface-border focus-within:ring-[var(--vscode-focusBorder)] shadow-sm">
            <Search className="h-4 w-4 shrink-0 text-[var(--vscode-descriptionForeground)]" />
            <input
              ref={searchInputRef}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--vscode-input-foreground)] outline-none placeholder:text-[var(--vscode-descriptionForeground)]"
              placeholder={search.mode === "files" ? t("searchFilesPlaceholder") : t("searchInFilesPlaceholder")}
              value={search.query}
              onFocus={() => setActiveView("search")}
              onBlur={() => {
                window.setTimeout(() => {
                  const q = searchInputRef.current?.value?.trim() ?? "";
                  const active = document.activeElement as HTMLElement | null;
                  const within = Boolean(active && searchContainerRef.current && searchContainerRef.current.contains(active));
                  if (!q && !within) setActiveView("explorer");
                }, 0);
              }}
              onChange={(e) => {
                const next = e.target.value;
                setActiveView("search");
                setSearch((s) => ({ ...s, query: next }));
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                const isMod = e.metaKey || e.ctrlKey;
                if (e.key === "Escape") {
                  e.preventDefault();
                  setActiveView("explorer");
                  setSearch((s) => ({ ...s, query: "", fileResults: [], contentResults: null, selectedIndex: 0, loading: false, error: undefined }));
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const count = search.mode === "files" ? search.fileResults.length : contentIndex.flat.length;
                  setSearch((s) => {
                    if (count <= 0) return s;
                    return { ...s, selectedIndex: Math.min(count - 1, s.selectedIndex + 1) };
                  });
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSearch((s) => ({ ...s, selectedIndex: Math.max(0, s.selectedIndex - 1) }));
                  return;
                }
                if (e.key === "Enter" && !isMod) {
                  e.preventDefault();
                  openSelected();
                }
              }}
            />
            {search.query ? (
              <button
                className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                onClick={() => {
                  setSearch((s) => ({ ...s, query: "", fileResults: [], contentResults: null, selectedIndex: 0, loading: false, error: undefined }));
                  window.setTimeout(() => searchInputRef.current?.focus(), 0);
                }}
                type="button"
                title="Clear"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {activeView === "search" ? (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex items-center gap-1">
                <button
                  className={[
                    "rounded px-2 py-1 text-[11px]",
                    search.mode === "files"
                      ? "bg-[var(--vscode-sideBarSectionHeader-background)] text-[var(--vscode-foreground)]"
                      : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                  ].join(" ")}
                  onClick={() => setSearch((s) => ({ ...s, mode: "files", selectedIndex: 0 }))}
                  type="button"
                >
                  {t("files")}
                </button>
                <button
                  className={[
                    "rounded px-2 py-1 text-[11px]",
                    search.mode === "content"
                      ? "bg-[var(--vscode-sideBarSectionHeader-background)] text-[var(--vscode-foreground)]"
                      : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                  ].join(" ")}
                  onClick={() => setSearch((s) => ({ ...s, mode: "content", selectedIndex: 0 }))}
                  type="button"
                >
                  {t("search")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {isBound ? (
          <div className={activeView === "explorer" ? "h-full" : "hidden"}>
            <ExplorerTree
              slot={slot}
              projectId={projectId}
              rootPath={rootPath}
              isVisible={activeView === "explorer"}
              onOpenFile={(rel) => onOpenFile(rel)}
              onOpenGitDiff={onOpenGitDiff}
              onDeletedPaths={onDeletedPaths}
            />
          </div>
        ) : (
          <div className="p-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("explorerUnbound")}</div>
        )}

        <div className={activeView === "search" ? "flex h-full min-h-0 flex-col" : "hidden"} data-search-container>
          <div className="min-h-0 flex-1 px-2 pb-2">
            <div
              className="grid min-h-0 h-full"
              style={{
                gridTemplateRows: `${search.dividerY}% 4px ${100 - search.dividerY}%`
              }}
            >
              <div className="min-h-0 overflow-auto rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
                {search.loading ? <div className="px-3 py-2 text-sm text-[var(--vscode-descriptionForeground)]">{t("searching")}</div> : null}
                {search.error ? <div className="px-3 py-2 text-sm text-red-400">{search.error}</div> : null}

                {search.mode === "files"
                  ? search.fileResults.map((r, idx) => (
                      <button
                        key={r.relativePath}
                        className={[
                          "block w-full truncate px-3 py-1 text-left text-sm",
                          idx === search.selectedIndex
                            ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                            : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                        ].join(" ")}
                        onClick={() => setSearch((s) => ({ ...s, selectedIndex: idx }))}
                        onDoubleClick={() => onOpenFile(r.relativePath)}
                        type="button"
                        title={r.relativePath}
                      >
                        {r.relativePath}
                      </button>
                    ))
                  : contentIndex.files.map((file) => (
                      <div key={file.relativePath} className="border-b border-[var(--vscode-panel-border)]">
                        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-[var(--vscode-sideBarSectionHeader-background)] px-3 py-1 text-[11px] text-[var(--vscode-foreground)]">
                          <span className="min-w-0 truncate">{file.relativePath}</span>
                          <span className="shrink-0 text-[var(--vscode-descriptionForeground)]">{file.matchCount}</span>
                        </div>
                        {file.lines.map((m) => (
                          <button
                            key={`${m.relativePath}:${m.line}`}
                            className={[
                              "block w-full px-3 py-1 text-left text-sm",
                              m.index === search.selectedIndex
                                ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                                : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                            ].join(" ")}
                            onClick={() => setSearch((s) => ({ ...s, selectedIndex: m.index }))}
                            onDoubleClick={() => onOpenFile(m.relativePath, m.line, m.column)}
                            type="button"
                            title={`${m.relativePath}:${m.line}`}
                          >
                            <div className="truncate">
                              <span className="mr-2 text-[var(--vscode-descriptionForeground)]">{m.line}</span>
                              <span className="truncate">{m.content}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    ))}
              </div>

              <div
                className="cursor-row-resize bg-[var(--vscode-panel-border)]"
                onMouseDown={handleDividerMouseDown}
                role="separator"
                aria-orientation="horizontal"
              />

              <div className="min-h-0 overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
                {search.mode === "content" && selectedItem && !("score" in selectedItem) ? (
                  <SearchPreviewPanel
                    slot={slot}
                    path={selectedItem.relativePath}
                    line={selectedItem.line}
                    query={search.query}
                  />
                ) : (
                  <SearchPreviewPanel slot={slot} path={selectedItem ? selectedItem.relativePath : null} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
