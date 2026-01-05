import { useI18n } from "./i18n";

type RecentProject = { id: string; name: string; path: string; lastOpenedAt: number };

type Props = {
  recentProjects: RecentProject[];
  onOpenFolder: () => void;
  onOpenRecent: (project: RecentProject) => void;
};

export default function WelcomeView({ recentProjects, onOpenFolder, onOpenRecent }: Props) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[var(--vscode-editor-background)] p-6">
      <div className="w-full max-w-[720px]">
        <div className="mb-2 text-2xl font-semibold text-[var(--vscode-foreground)]">{t("welcomeTitle")}</div>
        <div className="mb-6 text-sm text-[var(--vscode-descriptionForeground)]">{t("welcomeSubtitle")}</div>

        <div className="mb-6">
          <button
            className="rounded bg-[var(--vscode-button-background)] px-4 py-2 text-sm text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
            onClick={onOpenFolder}
            type="button"
          >
            {t("openFolder")}
          </button>
        </div>

        <div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
          <div className="border-b border-[var(--vscode-panel-border)] px-3 py-2 text-[11px] font-semibold tracking-wide text-[var(--vscode-sideBar-foreground)]">
            {t("recentProjects")}
          </div>
          {recentProjects.length === 0 ? (
            <div className="px-3 py-3 text-sm text-[var(--vscode-descriptionForeground)]">{t("noRecentProjects")}</div>
          ) : (
            <div className="max-h-[320px] overflow-auto p-1">
              {recentProjects.map((p) => (
                <button
                  key={p.id}
                  className="flex w-full flex-col rounded px-2 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                  onClick={() => onOpenRecent(p)}
                  type="button"
                  title={p.path}
                >
                  <div className="truncate text-sm text-[var(--vscode-foreground)]">{p.name}</div>
                  <div className="truncate text-[11px] text-[var(--vscode-descriptionForeground)]">{p.path}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
