import { FileText, Minus, Plus, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n";

type Props = {
  slot: number;
  projectId?: string;
  rootPath?: string;
  isBound: boolean;
  width?: number;
  onOpenFolder: () => void;
  onOpenDiff: (relPath: string, mode: "working" | "staged") => void;
  onOpenFile: (relPath: string) => void;
};

type GitChangesState = {
  isRepo: boolean;
  repoRoot?: string;
  branch?: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflict: string[];
  statusByPath: Record<string, string>;
};

function normalizeAbsPath(p: string) {
  return String(p ?? "").replace(/[\\\\]+/g, "/").replace(/\/+$/, "");
}

function statusBadgeClass(letter: string) {
  if (letter === "?") return "bg-sky-600/40 text-sky-200";
  if (letter === "A") return "bg-emerald-600/40 text-emerald-200";
  if (letter === "D") return "bg-red-600/40 text-red-200";
  if (letter === "U") return "bg-purple-600/40 text-purple-200";
  if (letter === "R" || letter === "C") return "bg-blue-600/40 text-blue-200";
  return "bg-amber-600/40 text-amber-200";
}

export default function GitPanel({ slot, projectId, rootPath, isBound, width, onOpenFolder, onOpenDiff, onOpenFile }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState("");
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [changes, setChanges] = useState<GitChangesState>(() => ({
    isRepo: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflict: [],
    statusByPath: {}
  }));

  const debounceTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!isBound) return;
    setLoading(true);
    const res = await window.xcoding.project.gitChanges({ slot, maxEntries: 50000 });
    if (!res.ok) {
      setError(res.reason ?? "git_changes_failed");
      setLoading(false);
      return;
    }
    setChanges({
      isRepo: Boolean(res.isRepo),
      repoRoot: typeof res.repoRoot === "string" ? res.repoRoot : undefined,
      branch: typeof res.branch === "string" ? res.branch : undefined,
      staged: res.staged ?? [],
      unstaged: res.unstaged ?? [],
      untracked: res.untracked ?? [],
      conflict: res.conflict ?? [],
      statusByPath: res.statusByPath ?? {}
    });
    setError("");
    setLoading(false);
  }, [isBound, slot]);

  const repoRootMismatch = useMemo(() => {
    if (!isBound) return false;
    if (!changes.isRepo) return false;
    if (!changes.repoRoot || !rootPath) return false;
    return normalizeAbsPath(changes.repoRoot) !== normalizeAbsPath(rootPath);
  }, [changes.isRepo, changes.repoRoot, isBound, rootPath]);

  useEffect(() => {
    setError("");
    setCommitMessage("");
    setSelected(null);
    setChanges({ isRepo: false, staged: [], unstaged: [], untracked: [], conflict: [], statusByPath: {} });
    if (isBound) void refresh();
  }, [isBound, refresh, slot]);

  useEffect(() => {
    if (!projectId) return;
    const schedule = () => {
      if (debounceTimerRef.current != null) return;
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void refresh();
      }, 150);
    };
    const dispose = window.xcoding.events.onProjectEvent((evt) => {
      if (evt.projectId !== projectId) return;
      if (evt.type !== "watcher") return;
      schedule();
    });
    return () => {
      if (debounceTimerRef.current != null) window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      dispose();
    };
  }, [projectId, refresh]);

  const canCommit = !busy && changes.isRepo && !repoRootMismatch && changes.staged.length > 0 && commitMessage.trim().length > 0;

  async function runAction(action: () => Promise<{ ok: boolean; reason?: string }>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await action();
      if (!res.ok) setError(res.reason ?? "git_action_failed");
      else setError("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function open(path: string, staged: boolean) {
    const normalized = String(path ?? "").trim().replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/");
    if (!normalized) return;
    setSelected({ path: normalized, staged });
    onOpenDiff(normalized, staged ? "staged" : "working");
  }

  function quickOpenFile(path: string) {
    const normalized = String(path ?? "").trim().replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/");
    if (!normalized) return;
    onOpenFile(normalized);
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

      <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2 py-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-[var(--vscode-sideBar-foreground)]">{t("review")}</div>
          <div className="truncate text-[10px] text-[var(--vscode-descriptionForeground)]">
            {changes.isRepo ? (changes.branch ? `${changes.branch}` : t("gitRepo")) : t("gitNotRepo")}
          </div>
        </div>
        <button
          type="button"
          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
          onClick={() => void refresh()}
          title={t("refresh")}
          disabled={!isBound || loading}
        >
          <RefreshCw className={["h-4 w-4", loading ? "animate-spin" : ""].join(" ")} />
        </button>
      </div>

      {error ? <div className="border-b border-[var(--vscode-panel-border)] px-2 py-2 text-[11px] text-red-400">{error}</div> : null}

      {isBound && changes.isRepo && repoRootMismatch ? (
        <div className="border-b border-[var(--vscode-panel-border)] px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
          {t("gitRepoRootMismatch")}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-1">
        {isBound && changes.isRepo && !repoRootMismatch ? (
          <>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
              {t("gitStaged")} ({changes.staged.length})
            </div>
            <div className="mb-2">
              {changes.staged.length ? (
                <button
                  type="button"
                  className="mb-1 w-full rounded px-2 py-1 text-left text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                  onClick={() => void runAction(() => window.xcoding.project.gitUnstage({ slot, paths: changes.staged }))}
                  disabled={busy}
                >
                  <span className="inline-flex items-center gap-1">
                    <Minus className="h-3.5 w-3.5" />
                    {t("gitUnstageAll")}
                  </span>
                </button>
              ) : null}
              {changes.staged.map((p) => {
                const isSelected = selected?.path === p && selected?.staged === true;
                const letter = changes.statusByPath[p] ?? "M";
                return (
                  <div
                    key={`staged:${p}`}
                    className={[
                      "group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]",
                      isSelected
                        ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                        : "hover:bg-[var(--vscode-list-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => open(p, true)}
                    onDoubleClick={() => quickOpenFile(p)}
                    title={p}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(p, true);
                      }
                    }}
                  >
                    <span className={["rounded px-1 py-0.5 text-[10px] leading-none", statusBadgeClass(letter)].join(" ")}>{letter}</span>
                    <span className="min-w-0 flex-1 truncate">{p}</span>
                    <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("open")}
                        onClick={(e) => {
                          e.stopPropagation();
                          quickOpenFile(p);
                        }}
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("gitUnstage")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runAction(() => window.xcoding.project.gitUnstage({ slot, paths: [p] }));
                        }}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
              {t("gitChanges")} ({changes.unstaged.length})
            </div>
            <div className="mb-2">
              {changes.unstaged.length ? (
                <button
                  type="button"
                  className="mb-1 w-full rounded px-2 py-1 text-left text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                  onClick={() => void runAction(() => window.xcoding.project.gitStage({ slot, paths: changes.unstaged }))}
                  disabled={busy}
                >
                  <span className="inline-flex items-center gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    {t("gitStageAll")}
                  </span>
                </button>
              ) : null}
              {changes.unstaged.map((p) => {
                const isSelected = selected?.path === p && selected?.staged === false;
                const letter = changes.statusByPath[p] ?? "M";
                return (
                  <div
                    key={`unstaged:${p}`}
                    className={[
                      "group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]",
                      isSelected
                        ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                        : "hover:bg-[var(--vscode-list-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => open(p, false)}
                    onDoubleClick={() => quickOpenFile(p)}
                    title={p}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(p, false);
                      }
                    }}
                  >
                    <span className={["rounded px-1 py-0.5 text-[10px] leading-none", statusBadgeClass(letter)].join(" ")}>{letter}</span>
                    <span className="min-w-0 flex-1 truncate">{p}</span>
                    <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("open")}
                        onClick={(e) => {
                          e.stopPropagation();
                          quickOpenFile(p);
                        }}
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("gitStage")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runAction(() => window.xcoding.project.gitStage({ slot, paths: [p] }));
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("gitDiscard")}
                        onClick={(e) => {
                          e.stopPropagation();
                          const ok = window.confirm(`${t("gitDiscard")} "${p}"?`);
                          if (!ok) return;
                          void runAction(() => window.xcoding.project.gitDiscard({ slot, paths: [p] }));
                        }}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
              {t("gitUntracked")} ({changes.untracked.length})
            </div>
            <div className="mb-2">
              {changes.untracked.length ? (
                <button
                  type="button"
                  className="mb-1 w-full rounded px-2 py-1 text-left text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                  onClick={() => void runAction(() => window.xcoding.project.gitStage({ slot, paths: changes.untracked }))}
                  disabled={busy}
                >
                  <span className="inline-flex items-center gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    {t("gitStageAll")}
                  </span>
                </button>
              ) : null}
              {changes.untracked.map((p) => {
                const isSelected = selected?.path === p && selected?.staged === false;
                const letter = changes.statusByPath[p] ?? "?";
                return (
                  <div
                    key={`untracked:${p}`}
                    className={[
                      "group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]",
                      isSelected
                        ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                        : "hover:bg-[var(--vscode-list-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => open(p, false)}
                    onDoubleClick={() => quickOpenFile(p)}
                    title={p}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(p, false);
                      }
                    }}
                  >
                    <span className={["rounded px-1 py-0.5 text-[10px] leading-none", statusBadgeClass(letter)].join(" ")}>{letter}</span>
                    <span className="min-w-0 flex-1 truncate">{p}</span>
                    <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("open")}
                        onClick={(e) => {
                          e.stopPropagation();
                          quickOpenFile(p);
                        }}
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("gitStage")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runAction(() => window.xcoding.project.gitStage({ slot, paths: [p] }));
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        title={t("delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          const ok = window.confirm(`${t("delete")} "${p}"?`);
                          if (!ok) return;
                          void runAction(() => window.xcoding.project.gitDiscard({ slot, paths: [p], includeUntracked: true }));
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>

      <div className="border-t border-[var(--vscode-panel-border)] p-2">
        <textarea
          className="h-16 w-full resize-none rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] placeholder:text-[var(--vscode-descriptionForeground)] focus:ring-[var(--vscode-focusBorder)]"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder={t("gitCommitMessagePlaceholder")}
          disabled={!changes.isRepo || repoRootMismatch}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-[11px] text-[var(--vscode-descriptionForeground)]">
            {changes.isRepo ? `${t("gitStaged")} ${changes.staged.length}` : ""}
          </div>
          <button
            type="button"
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-[12px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-60"
            disabled={!canCommit}
            onClick={() => {
              void runAction(async () => {
                const res = await window.xcoding.project.gitCommit({ slot, message: commitMessage });
                if (res.ok) setCommitMessage("");
                return res;
              });
            }}
          >
            {t("gitCommit")}
          </button>
        </div>
      </div>
    </aside>
  );
}
