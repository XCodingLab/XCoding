import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import { getExplorerIcon } from "./fileIcons";
import { useI18n } from "./i18n";

export type FsEntry = { name: string; kind: "dir" | "file"; ignored?: boolean };

type NodeState = {
  entries?: FsEntry[];
  loading?: boolean;
  error?: string;
};

type Props = {
  slot: number;
  projectId?: string;
  rootPath?: string;
  onOpenFile: (relPath: string) => void;
  onDeletedPaths?: (paths: string[]) => void;
  isVisible?: boolean;
};

type ContextMenuState =
  | { isOpen: false }
  | { isOpen: true; x: number; y: number; dir: string; target?: { rel: string; kind: "dir" | "file" } };

type InlineEditState =
  | { mode: "none" }
  | { mode: "newFile"; dir: string; value: string }
  | { mode: "newFolder"; dir: string; value: string }
  | { mode: "rename"; rel: string; kind: "dir" | "file"; value: string };

type Row =
  | { type: "entry"; rel: string; name: string; kind: "dir" | "file"; depth: number; ignored?: boolean }
  | { type: "inline"; key: string; mode: "newFile" | "newFolder"; dir: string; depth: number }
  | { type: "message"; key: string; depth: number; tone: "info" | "error"; message: string };

function joinRel(dir: string, name: string) {
  const cleanedDir = dir.replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/").replace(/\/+$/, "");
  const cleanedName = name.replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/");
  if (!cleanedDir) return cleanedName;
  return `${cleanedDir}/${cleanedName}`;
}

function parentDir(rel: string) {
  const cleaned = rel.replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/").replace(/\/+$/, "");
  if (!cleaned) return "";
  const idx = cleaned.lastIndexOf("/");
  return idx === -1 ? "" : cleaned.slice(0, idx);
}

function sortEntries(entries: FsEntry[]) {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export default function ExplorerTree({ slot, projectId, rootPath, onOpenFile, onDeletedPaths, isVisible = true }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [cache, setCache] = useState<Record<string, NodeState>>({});
  const [isUnbound, setIsUnbound] = useState(false);
  const [selectedRel, setSelectedRel] = useState<string>("");
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<ContextMenuState>({ isOpen: false });
  const [inlineEdit, setInlineEdit] = useState<InlineEditState>({ mode: "none" });
  const inlineInputRef = useRef<HTMLInputElement | null>(null);
  const expandedRef = useRef(expanded);
  const cacheRef = useRef(cache);
  const refreshQueueRef = useRef<Set<string>>(new Set());
  const refreshTimerRef = useRef<number | null>(null);
  const [renderLimit, setRenderLimit] = useState(450);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const becameVisibleRef = useRef<boolean>(isVisible);

  async function loadDir(dir: string) {
    setCache((prev) => ({ ...prev, [dir]: { ...prev[dir], loading: true, error: undefined } }));
    const res = await window.xcoding.project.listDir({ slot, dir });
    if (!res.ok) {
      if (res.reason === "project_unbound") setIsUnbound(true);
      setCache((prev) => ({ ...prev, [dir]: { ...prev[dir], loading: false, error: res.reason ?? "list_failed" } }));
      return;
    }
    setIsUnbound(false);
    setCache((prev) => ({
      ...prev,
      [dir]: { entries: sortEntries(res.entries ?? []), loading: false, error: undefined }
    }));
  }

  async function refreshGitStatus() {
    if (!isVisible) return;
    const res = await window.xcoding.project.gitStatus({ slot, maxEntries: 50000 });
    if (!res.ok) return;
    setGitStatus(res.entries ?? {});
  }

  function refreshVisibleDirs() {
    if (!isVisible) return;
    void loadDir("");
    void refreshGitStatus();
    for (const dir of Array.from(expandedRef.current)) {
      if (!dir) continue;
      if (!cacheRef.current[dir]?.entries) continue;
      void loadDir(dir);
    }
  }

  useEffect(() => {
    setCache({});
    setExpanded(new Set([""]));
    setSelectedRel("");
    setGitStatus({});
    setProblems({});
    setMenu({ isOpen: false });
    setInlineEdit({ mode: "none" });
    void loadDir("");
    void refreshGitStatus();
  }, [slot]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  useEffect(() => {
    if (!projectId) return;
    const flush = () => {
      refreshTimerRef.current = null;
      const dirs = Array.from(refreshQueueRef.current);
      refreshQueueRef.current.clear();
      for (const dir of dirs) void loadDir(dir);
      void refreshGitStatus();
    };
    const enqueue = (dir: string) => {
      refreshQueueRef.current.add(dir);
      if (refreshTimerRef.current != null) return;
      refreshTimerRef.current = window.setTimeout(flush, 120);
    };

    const dispose = window.xcoding.events.onProjectEvent((evt) => {
      if (evt.projectId !== projectId) return;
      if (evt.type === "lsp:diagnostics") {
        const relPath = String((evt as any).relativePath ?? "");
        if (!relPath) return;
        const diagnostics = Array.isArray((evt as any).diagnostics) ? ((evt as any).diagnostics as any[]) : [];
        const severity = diagnostics.reduce((acc, d) => Math.min(acc, Number(d.severity ?? 3)), 3);
        setProblems((prev) => ({ ...prev, [relPath]: severity }));
        return;
      }
      if (evt.type !== "watcher") return;
      const rel = typeof (evt as any).path === "string" ? String((evt as any).path) : "";
      if (!rel) return;
      const dir = parentDir(rel);
      const isInTree = dir === "" || expandedRef.current.has(dir);
      if (!isInTree) return;
      enqueue(dir);
    });

    return () => {
      if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      refreshQueueRef.current.clear();
      dispose();
    };
  }, [projectId, slot]);

  useEffect(() => {
    const prev = becameVisibleRef.current;
    becameVisibleRef.current = isVisible;
    if (!prev && isVisible) refreshVisibleDirs();
  }, [isVisible]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshVisibleDirs();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const root = useMemo(() => cache[""] ?? {}, [cache]);

  useEffect(() => {
    if (inlineEdit.mode === "none") return;
    const tmr = window.setTimeout(() => inlineInputRef.current?.focus(), 0);
    return () => window.clearTimeout(tmr);
  }, [inlineEdit]);

  function toggleDir(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!cache[dir]?.entries && !cache[dir]?.loading) void loadDir(dir);
  }

  async function ensureDirExpanded(dir: string) {
    if (expanded.has(dir)) return;
    setExpanded((prev) => new Set(prev).add(dir));
    if (!cache[dir]?.entries && !cache[dir]?.loading) await loadDir(dir);
  }

  function closeMenu() {
    setMenu({ isOpen: false });
  }

  function openContextMenu(e: React.MouseEvent, dir: string, target?: { rel: string; kind: "dir" | "file" }) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ isOpen: true, x: e.clientX, y: e.clientY, dir, target });
  }

  async function doCreateFile(dir: string, name: string) {
    const cleaned = name.trim();
    if (!cleaned) return;
    await ensureDirExpanded(dir);
    const rel = joinRel(dir, cleaned);
    const res = await window.xcoding.project.writeFile({ slot, path: rel, content: "" });
    if (!res.ok) return;
    await loadDir(dir);
    setSelectedRel(rel);
    onOpenFile(rel);
  }

  async function doCreateFolder(dir: string, name: string) {
    const cleaned = name.trim();
    if (!cleaned) return;
    await ensureDirExpanded(dir);
    const rel = joinRel(dir, cleaned);
    const res = await window.xcoding.project.mkdir({ slot, dir: rel });
    if (!res.ok) return;
    await loadDir(dir);
    setSelectedRel(rel);
    setExpanded((prev) => new Set(prev).add(rel));
    void loadDir(rel);
  }

  async function doRename(rel: string, nextName: string) {
    const cleaned = nextName.trim();
    if (!cleaned) return;
    const p = parentDir(rel);
    const to = joinRel(p, cleaned);
    const res = await window.xcoding.project.rename({ slot, from: rel, to });
    if (!res.ok) return;
    await loadDir(p);
    setSelectedRel(to);
  }

  async function doDelete(target: { rel: string; kind: "dir" | "file" }) {
    const ok = window.confirm(`${t("delete")} "${target.rel.split("/").pop() ?? target.rel}"?`);
    if (!ok) return;
    if (target.kind === "file") {
      const res = await window.xcoding.project.deleteFile({ slot, path: target.rel });
      if (!res.ok) {
        window.alert(`${t("delete")} failed: ${res.reason ?? "unknown_error"}`);
        return;
      }
      onDeletedPaths?.([target.rel]);
      await loadDir(parentDir(target.rel));
      if (selectedRel === target.rel) setSelectedRel("");
      return;
    }
    const res = await window.xcoding.project.deleteDir({ slot, dir: target.rel });
    if (!res.ok) {
      window.alert(`${t("delete")} failed: ${res.reason ?? "unknown_error"}`);
      return;
    }
    onDeletedPaths?.([`${target.rel.replace(/\/+$/, "")}/`]);
    await loadDir(parentDir(target.rel));
    if (selectedRel === target.rel) setSelectedRel("");
  }

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const pushDirChildren = (dir: string, depth: number) => {
      const node = cache[dir] ?? {};
      const entries = node.entries ?? [];
      const dirIsExpanded = dir === "" ? true : expanded.has(dir);
      if (!dirIsExpanded) return;

      if (node.error) out.push({ type: "message", key: `err:${dir}`, depth: depth + 1, tone: "error", message: node.error });
      else if (node.loading && entries.length === 0) out.push({ type: "message", key: `loading:${dir}`, depth: depth + 1, tone: "info", message: "Loading…" });

      for (const entry of entries) {
        const rel = joinRel(dir, entry.name);
        out.push({ type: "entry", rel, name: entry.name, kind: entry.kind, depth, ignored: entry.ignored });
        if (entry.kind === "dir") pushDirChildren(rel, depth + 1);
      }

      if (inlineEdit.mode === "newFile" && inlineEdit.dir === dir) {
        out.push({ type: "inline", key: `inline:newFile:${dir}`, mode: "newFile", dir, depth: depth + 1 });
      }
      if (inlineEdit.mode === "newFolder" && inlineEdit.dir === dir) {
        out.push({ type: "inline", key: `inline:newFolder:${dir}`, mode: "newFolder", dir, depth: depth + 1 });
      }
    };

    pushDirChildren("", 0);
    return out;
  }, [cache, expanded, inlineEdit]);

  useEffect(() => {
    setRenderLimit((prev) => Math.min(prev, rows.length || 450));
  }, [rows.length]);

  useEffect(() => {
    if (!isVisible) return;
    if (renderLimit >= rows.length) return;
    const tmr = window.setTimeout(() => {
      setRenderLimit((prev) => Math.min(rows.length, prev + 260));
    }, 16);
    return () => window.clearTimeout(tmr);
  }, [isVisible, renderLimit, rows.length]);

  const visibleRows = useMemo(() => rows.slice(0, renderLimit), [rows, renderLimit]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      onClick={() => {
        closeMenu();
        if (inlineEdit.mode !== "none") setInlineEdit({ mode: "none" });
      }}
      onContextMenu={(e) => openContextMenu(e, "")}
    >
      <div className="flex h-8 items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2">
        <div className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-[var(--vscode-sideBar-foreground)]">{t("files")}</div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              setInlineEdit({ mode: "newFile", dir: "", value: "new-file.txt" });
            }}
            type="button"
            title={t("newFile")}
          >
            <FilePlus className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              setInlineEdit({ mode: "newFolder", dir: "", value: "new-folder" });
            }}
            type="button"
            title={t("newFolder")}
          >
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => refreshVisibleDirs()}
            type="button"
            title={t("refresh")}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isUnbound ? <div className="px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("explorerUnbound")}</div> : null}
      {root.error ? <div className="px-2 py-1 text-[11px] text-red-400">{root.error}</div> : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto py-1"
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 420;
          if (!nearBottom) return;
          if (renderLimit >= rows.length) return;
          setRenderLimit((prev) => Math.min(rows.length, prev + 520));
        }}
      >
        {visibleRows.map((row) => {
          if (row.type === "message") {
            return (
              <div
                key={row.key}
                className={[
                  "px-2 py-1 text-[11px]",
                  row.tone === "error" ? "text-red-400" : "text-[var(--vscode-descriptionForeground)]"
                ].join(" ")}
                style={{ paddingLeft: `${row.depth * 12 + 12}px` }}
              >
                {row.message}
              </div>
            );
          }

          if (row.type === "inline") {
            const inlineValue = inlineEdit.mode === row.mode ? inlineEdit.value : "";
            return (
              <div key={row.key} className="px-2 py-0.5" style={{ paddingLeft: `${row.depth * 12 + 12}px` }}>
                <input
                  ref={inlineInputRef}
                  className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                  value={inlineValue}
                  onChange={(e) => setInlineEdit((s) => (s.mode === row.mode ? { ...s, value: e.target.value } : s))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setInlineEdit({ mode: "none" });
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const next = inlineValue;
                      setInlineEdit({ mode: "none" });
                      if (row.mode === "newFile") void doCreateFile(row.dir, next);
                      if (row.mode === "newFolder") void doCreateFolder(row.dir, next);
                    }
                  }}
                />
              </div>
            );
          }

          const rel = row.rel;
          const isDir = row.kind === "dir";
          const isSelected = selectedRel === rel;
          const isExpanded = isDir && expanded.has(rel);
          const { Icon, colorClass } = getExplorerIcon(row.name, row.kind, isExpanded);
          const isRename = inlineEdit.mode === "rename" && inlineEdit.rel === rel;
          const rowTextClass = row.ignored ? "text-[var(--vscode-descriptionForeground)] opacity-70" : "text-[var(--vscode-sideBar-foreground)]";
          const git = gitStatus[rel] ?? "";
          const problemSeverity = problems[rel] ?? 0;

          return (
            <button
              key={rel}
              className={[
                "flex w-full items-center gap-1 truncate rounded px-2 py-0.5 text-left text-[12px]",
                isSelected
                  ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                  : "hover:bg-[var(--vscode-list-hoverBackground)]"
              ].join(" ")}
              style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
              draggable
              onClick={() => {
                setSelectedRel(rel);
                if (isDir) {
                  toggleDir(rel);
                  return;
                }
                if (!isRename) onOpenFile(rel);
              }}
              onContextMenu={(e2) => {
                setSelectedRel(rel);
                openContextMenu(e2, parentDir(rel), { rel, kind: row.kind });
              }}
              onDragStart={(e2) => {
                try {
                  const dt = e2.dataTransfer;
                  if (!dt) return;
                  dt.setData("application/x-xcoding-relpath", rel);
                  dt.setData("text/plain", rel);
                  dt.effectAllowed = "copy";
                } catch {
                  // ignore
                }
              }}
              type="button"
              title={rel}
            >
              {isDir ? (
                <span className="flex h-4 w-4 items-center justify-center text-[var(--vscode-descriptionForeground)]">
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              ) : (
                <span className="h-4 w-4" />
              )}
              <Icon className={["h-4 w-4 shrink-0", colorClass].join(" ")} />
              {isRename ? (
                <input
                  ref={inlineInputRef}
                  className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-1 py-0.5 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                  value={inlineEdit.mode === "rename" ? inlineEdit.value : row.name}
                  onChange={(e2) => setInlineEdit((s) => (s.mode === "rename" ? { ...s, value: e2.target.value } : s))}
                  onClick={(e2) => e2.stopPropagation()}
                  onKeyDown={(e2) => {
                    if (e2.key === "Escape") setInlineEdit({ mode: "none" });
                    if (e2.key === "Enter") {
                      e2.preventDefault();
                      const next = inlineEdit.mode === "rename" ? inlineEdit.value : row.name;
                      setInlineEdit({ mode: "none" });
                      void doRename(rel, next);
                    }
                  }}
                />
              ) : (
                <span className={["min-w-0 flex-1 truncate", rowTextClass].join(" ")}>{row.name}</span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {problemSeverity ? (
                  <span
                    className={[
                      "h-2 w-2 rounded-full",
                      problemSeverity === 1 ? "bg-red-500" : problemSeverity === 2 ? "bg-amber-500" : "bg-sky-500"
                    ].join(" ")}
                    title={problemSeverity === 1 ? t("errors") : problemSeverity === 2 ? t("warnings") : t("info")}
                  />
                ) : null}
                {git ? (
                  <span
                    className={[
                      "rounded px-1 py-0.5 text-[10px] leading-none",
                      git.includes("?") ? "bg-sky-600/40 text-sky-200" : git.includes("A") ? "bg-emerald-600/40 text-emerald-200" : git.includes("D") ? "bg-red-600/40 text-red-200" : "bg-amber-600/40 text-amber-200"
                    ].join(" ")}
                    title={`Git: ${git}`}
                  >
                    {git}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}

        {renderLimit < rows.length ? (
          <div className="px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loadingMore")}</div>
        ) : null}
      </div>

      {menu.isOpen ? (
        <div
          className="fixed z-50 min-w-[180px] rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-1 text-[11px] text-[var(--vscode-foreground)] shadow"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              setInlineEdit({ mode: "newFile", dir: menu.dir, value: "new-file.txt" });
            }}
            type="button"
          >
            {t("newFile")}
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              closeMenu();
              setInlineEdit({ mode: "newFolder", dir: menu.dir, value: "new-folder" });
            }}
            type="button"
          >
            {t("newFolder")}
          </button>
          {menu.target ? (
            <>
              <div className="my-1 border-t border-[var(--vscode-panel-border)]" />
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={async () => {
              const rel = menu.target!.rel;
              const abs = rootPath ? `${rootPath.replace(/\/+$/, "")}/${rel}` : rel;
              closeMenu();
              await window.xcoding.os.copyText(abs);
            }}
            type="button"
          >
            {t("copyPath")}
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={async () => {
              const rel = menu.target!.rel;
              closeMenu();
              await window.xcoding.os.copyText(rel);
            }}
            type="button"
          >
            {t("copyRelativePath")}
          </button>
            </>
          ) : null}
          {menu.target ? (
            <>
              <button
                className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                onClick={() => {
                  closeMenu();
                  const base = menu.target!.rel.split("/").pop() ?? "";
                  setInlineEdit({ mode: "rename", rel: menu.target!.rel, kind: menu.target!.kind, value: base });
                }}
                type="button"
              >
                {t("rename")}
              </button>
              <button
                className="block w-full rounded px-2 py-1 text-left text-red-300 hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                onClick={() => {
                  closeMenu();
                  void doDelete(menu.target!);
                }}
                type="button"
              >
                {t("delete")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
