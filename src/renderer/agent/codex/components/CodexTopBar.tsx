import { FileDiff, History, Plus, Settings } from "lucide-react";

type Props = {
  title: string;
  t: (key: any) => string;
  disableDiff: boolean;
  disableHistory: boolean;
  disableSettings: boolean;
  disableNewThread: boolean;
  onToggleDiff: () => void;
  onToggleHistory: () => void;
  onOpenSettings: () => void;
  onStartNewThread: () => void;
};

export default function CodexTopBar({
  title,
  t,
  disableDiff,
  disableHistory,
  disableSettings,
  disableNewThread,
  onToggleDiff,
  onToggleHistory,
  onOpenSettings,
  onStartNewThread
}: Props) {
  return (
    <div className="flex h-10 items-center justify-between gap-2 border-b border-glass-border bg-glass-bg px-2 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 truncate text-[12px] font-semibold text-[var(--vscode-foreground)]">{title}</div>
      </div>

      <div className="flex items-center gap-1">
        <button
          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
          onClick={onToggleDiff}
          type="button"
          title={t("toggleDiffPanel")}
          disabled={disableDiff}
        >
          <FileDiff className="h-4 w-4" />
        </button>
        <button
          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
          onClick={onToggleHistory}
          type="button"
          title={t("history")}
          disabled={disableHistory}
        >
          <History className="h-4 w-4" />
        </button>
        <button
          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
          onClick={onOpenSettings}
          type="button"
          title={t("settings")}
          disabled={disableSettings}
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
          onClick={onStartNewThread}
          type="button"
          title={t("newThread")}
          disabled={disableNewThread}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
