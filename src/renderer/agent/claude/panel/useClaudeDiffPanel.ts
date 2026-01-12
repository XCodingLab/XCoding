import { useCallback, useMemo, useState } from "react";

type DiffFile = {
  absPath: string;
  backupName: string;
  relPath?: string;
  added?: number;
  removed?: number;
};

type DiffState = {
  loading: boolean;
  original: string;
  modified: string;
  unifiedDiff?: string;
  unifiedTruncated?: boolean;
  error?: string;
};

type Params = {
  projectRootPath?: string;
  pushSystemMessage: (text: string) => void;
};

export function useClaudeDiffPanel({ projectRootPath, pushSystemMessage }: Params) {
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);
  const [isDiffPanelOpen, setIsDiffPanelOpen] = useState(false);
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);
  const [diffQuery, setDiffQuery] = useState("");
  const [diffStats, setDiffStats] = useState<Record<string, { added: number; removed: number }>>({});
  const [diffSelectedAbsPath, setDiffSelectedAbsPath] = useState<string>("");
  const [diffState, setDiffState] = useState<DiffState>({
    loading: false,
    original: "",
    modified: ""
  });

  const toDisplayPath = useCallback(
    (absPath: string) => {
      const abs = String(absPath ?? "");
      const root = String(projectRootPath ?? "");
      if (!abs) return "";
      const fromRel = diffFiles.find((f) => f.absPath === absPath && typeof f.relPath === "string") ?? null;
      if (fromRel?.relPath) return String(fromRel.relPath);
      if (root && abs.startsWith(root)) {
        const cut = abs.slice(root.length);
        return cut.startsWith("/") ? cut.slice(1) : cut || abs;
      }
      return abs;
    },
    [diffFiles, projectRootPath]
  );

  const refreshDiffFiles = useCallback(async () => {
    if (!projectRootPath || !diffSessionId) return;
    try {
      const res = await window.xcoding.claude.latestSnapshotFiles({ projectRootPath, sessionId: diffSessionId });
      if (res?.ok && Array.isArray(res.files)) {
        const rows = res.files
          .map((f: any) => ({
            absPath: String(f.absPath ?? ""),
            backupName: String(f.backupName ?? ""),
            relPath: typeof f.relPath === "string" ? String(f.relPath) : undefined,
            added: typeof f.added === "number" ? Number(f.added) : undefined,
            removed: typeof f.removed === "number" ? Number(f.removed) : undefined
          }))
          .filter((f: any) => f.absPath) as DiffFile[];
        rows.sort((a, b) => toDisplayPath(a.absPath).localeCompare(toDisplayPath(b.absPath)));
        setDiffFiles(rows);

        setDiffStats(() => {
          const next: Record<string, { added: number; removed: number }> = {};
          for (const r of rows) {
            if (typeof r.added === "number" && typeof r.removed === "number") next[r.absPath] = { added: r.added, removed: r.removed };
          }
          return next;
        });
        return;
      }
      pushSystemMessage(`Failed to load snapshot files: ${String(res?.reason ?? "unknown")}`);
      setDiffFiles([]);
      setDiffStats({});
    } catch (e) {
      pushSystemMessage(`Failed to load snapshot files: ${e instanceof Error ? e.message : String(e)}`);
      setDiffFiles([]);
      setDiffStats({});
    }
  }, [diffSessionId, projectRootPath, pushSystemMessage, toDisplayPath]);

  const visibleDiffFiles = useMemo(() => {
    const q = diffQuery.trim().toLowerCase();
    if (!q) return diffFiles;
    return diffFiles.filter((f) => toDisplayPath(f.absPath).toLowerCase().includes(q));
  }, [diffFiles, diffQuery, toDisplayPath]);

  const loadDiffForFile = useCallback(
    async (absPath: string) => {
      if (!projectRootPath || !diffSessionId) return;
      setDiffSelectedAbsPath(absPath);
      setDiffState((s) => ({ ...s, loading: true, error: undefined }));
      try {
        const res = await window.xcoding.claude.turnFileDiff({ projectRootPath, sessionId: diffSessionId, absPath });
        if (res?.ok) {
          setDiffState({
            loading: false,
            original: String(res.original ?? ""),
            modified: String(res.modified ?? ""),
            unifiedDiff: typeof res.unifiedDiff === "string" ? String(res.unifiedDiff) : "",
            unifiedTruncated: Boolean(res.unifiedTruncated)
          });
          const added = typeof res.added === "number" ? Number(res.added) : undefined;
          const removed = typeof res.removed === "number" ? Number(res.removed) : undefined;
          if (absPath && typeof added === "number" && typeof removed === "number") {
            setDiffStats((prev) => (prev[absPath] ? prev : { ...prev, [absPath]: { added, removed } }));
          }
          return;
        }
        setDiffState({
          loading: false,
          original: "",
          modified: "",
          unifiedDiff: "",
          unifiedTruncated: false,
          error: String(res?.reason ?? "diff_failed")
        });
      } catch (e) {
        setDiffState({
          loading: false,
          original: "",
          modified: "",
          unifiedDiff: "",
          unifiedTruncated: false,
          error: e instanceof Error ? e.message : String(e)
        });
        pushSystemMessage(`Failed to load diff: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [diffSessionId, projectRootPath, pushSystemMessage]
  );

  const openSelectedFile = useCallback(() => {
    if (!diffSelectedAbsPath) return;
    const relPath = toDisplayPath(diffSelectedAbsPath);
    if (!relPath || relPath === diffSelectedAbsPath) return;
    window.dispatchEvent(new CustomEvent("xcoding:openFile", { detail: { relPath } }));
  }, [diffSelectedAbsPath, toDisplayPath]);

  const resetDiffListState = useCallback(() => {
    setDiffFiles([]);
    setDiffQuery("");
    setDiffStats({});
    setDiffSelectedAbsPath("");
  }, []);

  return {
    diffSessionId,
    setDiffSessionId,
    isDiffPanelOpen,
    setIsDiffPanelOpen,
    diffFiles,
    setDiffFiles,
    diffQuery,
    setDiffQuery,
    diffStats,
    setDiffStats,
    diffSelectedAbsPath,
    setDiffSelectedAbsPath,
    diffState,
    setDiffState,
    toDisplayPath,
    refreshDiffFiles,
    visibleDiffFiles,
    loadDiffForFile,
    openSelectedFile,
    resetDiffListState
  };
}

