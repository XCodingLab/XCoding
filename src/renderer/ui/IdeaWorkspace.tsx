import MarkdownPreviewView from "./MarkdownPreviewView";
import { useI18n } from "./i18n";

type Props = {
  slot: number;
  projectRootPath?: string;
  docPath: string;
  onStartDevelop: () => void;
  onOpenUrl: (url: string) => void;
  onOpenFile: (relPath: string) => void;
  chat: React.ReactNode;
};

export default function IdeaWorkspace({ slot, projectRootPath, docPath, onStartDevelop, onOpenUrl, onOpenFile, chat }: Props) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0">
      <div className="min-h-0 flex-1 border-r border-[var(--vscode-panel-border)]">
        <div className="flex h-10 items-center justify-between border-b border-[var(--vscode-panel-border)] px-3">
          <div className="text-[11px] font-semibold tracking-wide text-[var(--vscode-foreground)]">{t("requirementsDoc")}</div>
          <button
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-[12px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
            type="button"
            onClick={onStartDevelop}
          >
            {t("startDevelop")}
          </button>
        </div>
        <div className="min-h-0 h-[calc(100%-2.5rem)] overflow-auto">
          <MarkdownPreviewView
            slot={slot}
            path={docPath}
            projectRootPath={projectRootPath}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
      {chat}
    </div>
  );
}
