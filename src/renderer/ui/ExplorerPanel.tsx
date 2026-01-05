import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, FileText, Filter, Regex, Search, WholeWord, X } from "lucide-react";
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
  onOpenFolder: () => void;
  onDeletedPaths?: (paths: string[]) => void;
};

type SearchMode = "files" | "content";

type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  useGitignore: boolean;
  include: string;
  exclude: string;
  filePattern: string;
};

type FileSearchResult = { path: string; name: string; relativePath: string; score: number };
type ContentSearchMatch = { path: string; relativePath: string; line: number; column: number; content: string };
type ContentSearchResult = { matches: ContentSearchMatch[]; totalMatches: number; totalFiles: number; truncated: boolean };

type SearchState = {
  mode: SearchMode;
  query: string;
  options: SearchOptions;
  fileResults: FileSearchResult[];
  contentResults: ContentSearchResult | null;
  selectedIndex: number;
  loading: boolean;
  error?: string;
  dividerY: number;
};

function parseGlobInput(raw: string): string[] {
  const input = raw.trim();
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ExplorerPanel({ slot, projectId, rootPath, isBound, width, onOpenFile, onOpenFolder, onDeletedPaths }: Props) {
  const { t } = useI18n();
  const [activeView, setActiveView] = useState<"explorer" | "search">("explorer");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const [replaceValue, setReplaceValue] = useState("");
  const [replaceStatus, setReplaceStatus] = useState<string>("");

  const [search, setSearch] = useState<SearchState>(() => ({
    mode: "files",
    query: "",
    options: { caseSensitive: false, wholeWord: false, regex: false, useGitignore: true, include: "", exclude: "", filePattern: "" },
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
      options: { caseSensitive: false, wholeWord: false, regex: false, useGitignore: true, include: "", exclude: "", filePattern: "" },
      fileResults: [],
      contentResults: null,
      selectedIndex: 0,
      loading: false,
      dividerY: 55
    });
    setReplaceValue("");
    setReplaceStatus("");
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
          .searchFiles({ slot, query: q, maxResults: 120, useGitignore: search.options.useGitignore })
          .then((res) => {
            if (requestSeqRef.current !== seq) return;
            if (!res.ok) {
              setSearch((s) => ({ ...s, loading: false, error: res.reason ?? "search_failed" }));
              return;
            }
            setSearch((s) => ({ ...s, loading: false, error: undefined, fileResults: res.results ?? [], contentResults: null, selectedIndex: 0 }));
          });
        return;
      }

      const include = parseGlobInput(search.options.include);
      const exclude = parseGlobInput(search.options.exclude);
      const filePattern = search.options.filePattern.trim() || undefined;

      void window.xcoding.project
        .searchContent({
          slot,
          query: q,
          maxResults: 600,
          caseSensitive: search.options.caseSensitive,
          wholeWord: search.options.wholeWord,
          regex: search.options.regex,
          filePattern,
          include,
          exclude,
          useGitignore: search.options.useGitignore
        })
        .then((res) => {
          if (requestSeqRef.current !== seq) return;
          if (!res.ok) {
            setSearch((s) => ({ ...s, loading: false, error: res.reason ?? "search_failed" }));
            return;
          }
          setSearch((s) => ({ ...s, loading: false, error: undefined, fileResults: [], contentResults: res.result ?? null, selectedIndex: 0 }));
        });
    }, 180);
    return () => {
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    };
  }, [activeView, isBound, search.mode, search.options, search.query, slot]);

  const selectedItem = useMemo(() => {
    if (search.mode === "files") return search.fileResults[search.selectedIndex] ?? null;
    return search.contentResults?.matches?.[search.selectedIndex] ?? null;
  }, [search.contentResults?.matches, search.fileResults, search.mode, search.selectedIndex]);

  function openSelected() {
    if (!selectedItem) return;
    if ("score" in selectedItem) {
      onOpenFile(selectedItem.relativePath);
      return;
    }
    onOpenFile(selectedItem.relativePath, selectedItem.line, selectedItem.column);
  }

  async function replaceAll() {
    if (!isBound) return;
    const q = search.query.trim();
    if (!q || search.mode !== "content") return;
    const ok = window.confirm(`Replace all matches of "${q}"?`);
    if (!ok) return;

    setReplaceStatus("Replacing…");
    const include = parseGlobInput(search.options.include);
    const exclude = parseGlobInput(search.options.exclude);
    const filePattern = search.options.filePattern.trim() || undefined;
    const res = await window.xcoding.project.replaceContent({
      slot,
      query: q,
      replace: replaceValue,
      caseSensitive: search.options.caseSensitive,
      wholeWord: search.options.wholeWord,
      regex: search.options.regex,
      filePattern,
      include,
      exclude,
      useGitignore: search.options.useGitignore,
      maxFiles: 200,
      maxMatches: 5000,
      maxFileSize: "2M"
    });
    if (!res.ok) {
      setReplaceStatus(res.reason ?? "replace_failed");
      return;
    }
    const result = res.result;
    setReplaceStatus(
      result ? `Replaced ${result.changedMatches} matches in ${result.changedFiles} files.` : "Replace finished."
    );
    // Force a refresh of search results.
    setSearch((s) => ({ ...s, query: `${s.query} ` }));
    window.setTimeout(() => setSearch((s) => ({ ...s, query: s.query.trimEnd() })), 0);
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
      className="flex h-full min-h-0 shrink-0 flex-col border-r border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]"
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
        <div ref={searchContainerRef} className="border-b border-[var(--vscode-panel-border)] p-2">
          <div className="flex items-center gap-2 rounded bg-[var(--vscode-input-background)] px-2 py-1 ring-1 ring-[var(--vscode-input-border)] focus-within:ring-[var(--vscode-focusBorder)]">
            <Search className="h-4 w-4 shrink-0 text-[var(--vscode-descriptionForeground)]" />
            <input
              ref={searchInputRef}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--vscode-input-foreground)] outline-none placeholder:text-[var(--vscode-descriptionForeground)]"
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
                  setSearch((s) => {
                    const count = s.mode === "files" ? s.fileResults.length : s.contentResults?.matches.length ?? 0;
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
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
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

                <div className="flex items-center gap-1">
                  <button
                    className={[
                      "rounded p-1",
                      search.options.caseSensitive
                        ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                        : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => setSearch((s) => ({ ...s, options: { ...s.options, caseSensitive: !s.options.caseSensitive } }))}
                    type="button"
                    title="Match case"
                  >
                    <CaseSensitive className="h-4 w-4" />
                  </button>
                  <button
                    className={[
                      "rounded p-1",
                      search.options.wholeWord
                        ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                        : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => setSearch((s) => ({ ...s, options: { ...s.options, wholeWord: !s.options.wholeWord } }))}
                    type="button"
                    title="Match whole word"
                  >
                    <WholeWord className="h-4 w-4" />
                  </button>
                  <button
                    className={[
                      "rounded p-1",
                      search.options.regex
                        ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                        : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => setSearch((s) => ({ ...s, options: { ...s.options, regex: !s.options.regex } }))}
                    type="button"
                    title="Use regular expression"
                  >
                    <Regex className="h-4 w-4" />
                  </button>
                  <button
                    className={[
                      "rounded p-1",
                      search.options.useGitignore
                        ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                        : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => setSearch((s) => ({ ...s, options: { ...s.options, useGitignore: !s.options.useGitignore } }))}
                    type="button"
                    title="Use .gitignore"
                  >
                    <Filter className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {search.mode === "content" ? (
                <div className="grid gap-2">
                  <input
                    className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                    placeholder="files to include (glob, comma-separated)"
                    value={search.options.include}
                    onChange={(e) => setSearch((s) => ({ ...s, options: { ...s.options, include: e.target.value } }))}
                  />
                  <input
                    className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                    placeholder="files to exclude (glob, comma-separated)"
                    value={search.options.exclude}
                    onChange={(e) => setSearch((s) => ({ ...s, options: { ...s.options, exclude: e.target.value } }))}
                  />
                  <input
                    className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                    placeholder="file pattern (e.g. *.ts)"
                    value={search.options.filePattern}
                    onChange={(e) => setSearch((s) => ({ ...s, options: { ...s.options, filePattern: e.target.value } }))}
                  />
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-[var(--vscode-descriptionForeground)]" />
                    <input
                      className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                      placeholder="Replace…"
                      value={replaceValue}
                      onChange={(e) => setReplaceValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") void replaceAll();
                      }}
                    />
                    <button
                      className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
                      type="button"
                      disabled={!search.query.trim() || search.loading}
                      onClick={() => void replaceAll()}
                      title="Replace all"
                    >
                      Replace All
                    </button>
                  </div>
                  {replaceStatus ? <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{replaceStatus}</div> : null}
                </div>
              ) : null}
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
                  : (search.contentResults?.matches ?? []).map((m, idx) => (
                      <button
                        key={`${m.relativePath}:${m.line}:${m.column}:${idx}`}
                        className={[
                          "block w-full px-3 py-1 text-left text-sm",
                          idx === search.selectedIndex
                            ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                            : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                        ].join(" ")}
                        onClick={() => setSearch((s) => ({ ...s, selectedIndex: idx }))}
                        onDoubleClick={() => onOpenFile(m.relativePath, m.line, m.column)}
                        type="button"
                        title={`${m.relativePath}:${m.line}:${m.column}`}
                      >
                        <div className="truncate">
                          <span className="text-[var(--vscode-descriptionForeground)]">{m.relativePath}</span>{" "}
                          <span className="text-[var(--vscode-descriptionForeground)]">
                            {m.line}:{m.column}
                          </span>{" "}
                          <span className="truncate">{m.content}</span>
                        </div>
                      </button>
                    ))}
              </div>

              <div
                className="cursor-row-resize bg-[var(--vscode-panel-border)]"
                onMouseDown={handleDividerMouseDown}
                role="separator"
                aria-orientation="horizontal"
              />

              <div className="min-h-0 overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
                {search.mode === "content" && selectedItem && "line" in selectedItem ? (
                  <SearchPreviewPanel
                    slot={slot}
                    path={selectedItem.relativePath}
                    line={selectedItem.line}
                    query={search.query}
                    matchCase={search.options.caseSensitive}
                    regex={search.options.regex}
                  />
                ) : (
                  <SearchPreviewPanel slot={slot} path={selectedItem ? ("score" in selectedItem ? selectedItem.relativePath : selectedItem.relativePath) : null} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
