import { Archive, RefreshCcw } from "lucide-react";
import { useEffect } from "react";
import { extractPromptRequest } from "../prompt";
import { formatThreadTime, type ThreadSummary } from "../panel/types";

type Props = {
  open: boolean;
  t: (key: any) => string;
  projectRootPath?: string;
  query: string;
  onChangeQuery: (next: string) => void;
  isThreadsLoading: boolean;
  onRefresh: () => void | Promise<void>;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  isBusy: boolean;
  isTurnInProgress: boolean;
  onClose: () => void;
  onOpenThread: (threadId: string) => void | Promise<void>;
  onArchiveThread: (threadId: string) => void | Promise<void>;
};

export default function CodexHistoryOverlay({
  open,
  t,
  projectRootPath,
  query,
  onChangeQuery,
  isThreadsLoading,
  onRefresh,
  threads,
  activeThreadId,
  isBusy,
  isTurnInProgress,
  onClose,
  onOpenThread,
  onArchiveThread
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label={t("closeHistory")}
        className="absolute inset-0 z-40 bg-transparent backdrop-blur-sm cursor-default"
        onClick={onClose}
      />
      <div className="absolute left-3 right-3 top-3 z-50 flex h-[35%] min-h-0 flex-col overflow-hidden rounded-xl border border-glass-border bg-glass-bg-heavy shadow-2xl backdrop-blur-xl">
        <div className="border-b border-glass-border p-2">
          <div className="flex items-center gap-2">
            <input
              className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
              placeholder={t("searchRecentTasks")}
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
            />
            <button
              className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
              onClick={() => void onRefresh()}
              type="button"
              title={t("refresh")}
              disabled={isThreadsLoading}
            >
              <RefreshCcw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1">
          {isThreadsLoading ? (
            <div className="mb-2 rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
              Loading…
            </div>
          ) : null}
          {threads.length === 0 ? (
            <div className="rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
              {projectRootPath ? "No conversations yet." : "Bind a project folder to use Codex."}
            </div>
          ) : null}

          {threads.map((thread) => {
            const isActive = thread.id === activeThreadId;
            const preview =
              thread.previewText ??
              thread.title ??
              (thread.preview ? extractPromptRequest(thread.preview) : "") ??
              "";

            return (
              <div
                key={thread.id}
                className={[
                  "group relative w-full rounded px-2 py-2 text-left",
                  isActive
                    ? "bg-[var(--vscode-list-activeSelectionBackground)]"
                    : isTurnInProgress
                      ? "opacity-50"
                      : "hover:bg-[var(--vscode-list-hoverBackground)]"
                ].join(" ")}
                title={preview || thread.preview || thread.id}
              >
                <button
                  className="block w-full text-left"
                  type="button"
                  disabled={isBusy || isTurnInProgress}
                  onClick={() => {
                    onClose();
                    void onOpenThread(thread.id);
                  }}
                >
                  <div
                    className={[
                      "truncate text-[12px]",
                      isActive ? "text-[var(--vscode-list-activeSelectionForeground)]" : "text-[var(--vscode-foreground)]"
                    ].join(" ")}
                  >
                    {preview || thread.preview || "(no preview)"}
                  </div>
                  <div
                    className={[
                      "flex items-center justify-between gap-2 text-[10px]",
                      isActive
                        ? "text-[var(--vscode-list-activeSelectionForeground)]"
                        : "text-[var(--vscode-descriptionForeground)]"
                    ].join(" ")}
                  >
                    <div className="min-w-0 truncate" title={thread.cwd || ""}>
                      {thread.cwd || ""}
                    </div>
                    <div className="shrink-0">{formatThreadTime(thread.createdAt)}</div>
                  </div>
                </button>

                <button
                  className="invisible absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible disabled:opacity-50"
                  type="button"
                  title="Archive"
                  disabled={isBusy || isTurnInProgress}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onArchiveThread(thread.id);
                  }}
                >
                  <Archive className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
