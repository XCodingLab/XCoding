import { useMemo } from "react";
import MarkdownPreviewView from "./MarkdownPreviewView";
import { useI18n } from "./i18n";

type Props = {
  isOpen: boolean;
  projectName: string;
  slot: number;
  projectRootPath?: string;
  docPath: string;
  filesWritten: string[];
  onClose: () => void;
  onStartAuto: () => void;
  onSkip: () => void;
  onOpenUrl: (url: string) => void;
  onOpenFile: (relPath: string) => void;
  chat: React.ReactNode;
};

export default function IdeaFlowModal({
  isOpen,
  projectName,
  slot,
  projectRootPath,
  docPath,
  filesWritten,
  onClose,
  onStartAuto,
  onSkip,
  onOpenUrl,
  onOpenFile,
  chat
}: Props) {
  const { t } = useI18n();
  const title = useMemo(
    () => (projectName ? `${t("ideaFlowTitle")} · ${projectName}` : t("ideaFlowTitle")),
    [projectName, t]
  );
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="flex h-[82vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--vscode-panel-border)] px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--vscode-foreground)]">{title}</div>
            <div className="mt-0.5 truncate text-[12px] text-[var(--vscode-descriptionForeground)]">
              {t("ideaFlowSubtitle")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-[12px] font-semibold text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
              type="button"
              onClick={onStartAuto}
            >
              {t("startAutoWriting")}
            </button>
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-[12px] font-semibold text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              type="button"
              onClick={onSkip}
              title={t("skipIdeaAnalysis")}
            >
              {t("skip")}
            </button>
            <button
              className="rounded px-2 py-1 text-sm text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              onClick={onClose}
              type="button"
              title={t("close")}
            >
              ×
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[1.15fr_0.85fr]">
          <div className="min-h-0 border-r border-[var(--vscode-panel-border)]">
            <div className="flex h-10 items-center justify-between border-b border-[var(--vscode-panel-border)] px-3">
              <div className="text-[11px] font-semibold tracking-wide text-[var(--vscode-foreground)]">{t("documents")}</div>
              <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{docPath}</div>
            </div>
            <div className="min-h-0 h-[calc(100%-2.5rem)] overflow-auto p-2">
              <MarkdownPreviewView
                slot={slot}
                path={docPath}
                projectRootPath={projectRootPath}
                onOpenUrl={onOpenUrl}
                onOpenFile={onOpenFile}
              />
              {filesWritten.length ? (
                <div className="mt-3 rounded border border-[var(--vscode-panel-border)] bg-[rgba(255,255,255,0.02)]">
                  <div className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-[11px] font-semibold text-[var(--vscode-foreground)]">
                    {t("filesWrittenRecent")}
                  </div>
                  <div className="max-h-40 overflow-auto p-1">
                    {filesWritten.map((p) => (
                      <button
                        key={p}
                        className="block w-full truncate rounded px-2 py-1 text-left text-[11px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                        onClick={() => onOpenFile(p)}
                        type="button"
                        title={p}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="min-h-0">{chat}</div>
        </div>
      </div>
    </div>
  );
}
