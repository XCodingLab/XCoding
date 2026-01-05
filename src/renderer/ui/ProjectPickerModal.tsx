import { useMemo, useState } from "react";
import { useI18n } from "./i18n";

type Project = { id: string; name: string; path: string; lastOpenedAt: number };

type Props = {
  isOpen: boolean;
  projects: Project[];
  onClose: () => void;
  onPick: (project: Project) => void;
  onOpenFolder: () => void;
};

export default function ProjectPickerModal({ isOpen, projects, onClose, onPick, onOpenFolder }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ordered = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    if (!q) return ordered;
    return ordered.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [projects, query]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="w-full max-w-[720px] overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--vscode-panel-border)] px-3 py-2">
          <div className="text-sm font-semibold text-[var(--vscode-foreground)]">{t("projectPickerTitle")}</div>
          <button
            className="rounded px-2 py-1 text-sm text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="p-3">
          <div className="mb-2 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-2 py-1 text-sm text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
              placeholder={t("searchProjects")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-3 py-1 text-sm text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              onClick={onOpenFolder}
              type="button"
            >
              {t("openFolder")}
            </button>
          </div>

          <div className="max-h-[420px] overflow-auto rounded border border-[var(--vscode-panel-border)]">
            {list.length === 0 ? (
              <div className="px-3 py-3 text-sm text-[var(--vscode-descriptionForeground)]">{t("noResults")}</div>
            ) : (
              list.map((p) => (
                <button
                  key={p.id}
                  className="flex w-full flex-col border-b border-[var(--vscode-panel-border)] px-3 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                  onClick={() => onPick(p)}
                  type="button"
                  title={p.path}
                >
                  <div className="truncate text-sm text-[var(--vscode-foreground)]">{p.name}</div>
                  <div className="truncate text-[11px] text-[var(--vscode-descriptionForeground)]">{p.path}</div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
