import { useI18n } from "./i18n";
import FileEditor from "./FileEditor";

type Props = {
  slot: number;
  activeRelPath: string;
  onTakeOver: () => void;
  chat: React.ReactNode;
};

export default function AutoWorkspace({ slot, activeRelPath, onTakeOver, chat }: Props) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0">
      <div className="min-h-0 flex-1 border-r border-[var(--vscode-panel-border)]">
        <div className="flex h-10 items-center justify-between border-b border-[var(--vscode-panel-border)] px-3">
          <div className="text-[11px] font-semibold tracking-wide text-[var(--vscode-foreground)]">{t("autoWriting")}</div>
          <button
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1.5 text-[12px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
            type="button"
            onClick={onTakeOver}
          >
            {t("takeOverEnterDevelop")}
          </button>
        </div>
        <div className="min-h-0 h-[calc(100%-2.5rem)] overflow-auto">
          {activeRelPath ? (
            <FileEditor slot={slot} path={activeRelPath} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--vscode-descriptionForeground)]">
              {t("waitingForFileWrites")}
            </div>
          )}
        </div>
      </div>
      {chat}
    </div>
  );
}
