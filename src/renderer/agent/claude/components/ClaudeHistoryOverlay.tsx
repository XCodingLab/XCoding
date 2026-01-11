import { GitFork, RefreshCcw } from "lucide-react";
import { useEffect } from "react";

type SessionSummary = { sessionId: string; updatedAtMs: number; preview?: string };

type Props = {
  open: boolean;
  t: (key: any) => string;
  projectRootPath?: string;
  query: string;
  onChangeQuery: (next: string) => void;
  isLoading: boolean;
  onRefresh: () => void | Promise<void>;
  sessions: SessionSummary[];
  onClose: () => void;
  onLoadSession: (sessionId: string) => void | Promise<void>;
  onForkSession: (sessionId: string) => void | Promise<void>;
};

export default function ClaudeHistoryOverlay({
  open,
  t,
  projectRootPath,
  query,
  onChangeQuery,
  isLoading,
  onRefresh,
  sessions,
  onClose,
  onLoadSession,
  onForkSession
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
      <button type="button" aria-label={t("closeHistory")} className="absolute inset-0 z-40 bg-transparent backdrop-blur-sm cursor-default" onClick={onClose} />
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
              disabled={isLoading}
            >
              <RefreshCcw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1">
          {isLoading ? (
            <div className="mb-2 rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
              {t("loading")}…
            </div>
          ) : null}
          {sessions.length === 0 ? (
            <div className="rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
              {projectRootPath ? t("noResults") : t("codexBindProjectFolder")}
            </div>
          ) : null}

          {sessions.map((s) => {
            const preview = String(s.preview ?? "").trim();
            const title = preview || s.sessionId;
            const label = `${new Date(s.updatedAtMs).toLocaleString()} — ${title}`;
            return (
              <div
                key={s.sessionId}
                className="group relative w-full rounded px-2 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                title={label}
              >
                <button
                  className="block w-full text-left"
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    onClose();
                    void onLoadSession(s.sessionId);
                  }}
                >
                  <div className="truncate text-[12px] text-[var(--vscode-foreground)]">{title}</div>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
                    <div className="min-w-0 truncate" title={projectRootPath || ""}>
                      {projectRootPath || ""}
                    </div>
                    <div className="shrink-0">{new Date(s.updatedAtMs).toLocaleString()}</div>
                  </div>
                </button>

                <button
                  className="invisible absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible disabled:opacity-50"
                  type="button"
                  title="Fork"
                  disabled={isLoading}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onForkSession(s.sessionId);
                  }}
                >
                  <GitFork className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
