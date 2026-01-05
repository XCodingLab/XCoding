import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n";

type Project = { id: string; name: string; path: string; lastOpenedAt: number };

type Props = {
  isOpen: boolean;
  projects: Project[];
  onClose: () => void;
  onOpenExisting: () => void;
  onPickRecent: (project: Project) => void;
};

export default function NewProjectWizardModal({ isOpen, projects, onClose, onOpenExisting, onPickRecent }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const queryRef = useRef<HTMLInputElement | null>(null);

  const recent = useMemo(() => {
    const ordered = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [projects, query]);

  // Autofocus the search input when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    queueMicrotask(() => {
      requestAnimationFrame(() => queryRef.current?.focus());
    });
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-6 md:p-10"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-[980px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--vscode-panel-border)] px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-[var(--vscode-foreground)]">{t("openProject")}</div>
            <div className="mt-0.5 truncate text-[12px] text-[var(--vscode-descriptionForeground)]">{t("openProjectSubtitle")}</div>
          </div>
          <button
            className="rounded px-2 py-1 text-sm text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-6">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--vscode-foreground)]">{t("recentProjects")}</div>
              <input
                ref={queryRef}
                className="w-[360px] max-w-full rounded bg-[var(--vscode-input-background)] px-3 py-2 text-sm text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                placeholder={t("searchProjects")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="max-h-[320px] overflow-auto rounded-lg border border-[var(--vscode-panel-border)]">
              {recent.length === 0 ? (
                <div className="px-3 py-3 text-sm text-[var(--vscode-descriptionForeground)]">{t("noResults")}</div>
              ) : (
                recent.map((p) => (
                  <button
                    key={p.id}
                    className="flex w-full items-center justify-between gap-3 border-b border-[var(--vscode-panel-border)] px-4 py-3 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                    onClick={() => onPickRecent(p)}
                    type="button"
                    title={p.path}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[var(--vscode-foreground)]">{p.name}</div>
                      <div className="truncate text-[11px] text-[var(--vscode-descriptionForeground)]">{p.path}</div>
                    </div>
                    <div className="shrink-0 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("open")}</div>
                  </button>
                ))
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                className="rounded bg-[var(--vscode-button-secondaryBackground)] px-4 py-2 text-sm font-semibold text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                onClick={onOpenExisting}
                type="button"
              >
                {t("openFolder")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
