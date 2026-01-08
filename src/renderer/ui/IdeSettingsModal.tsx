import { useEffect, useMemo, useRef } from "react";
import { useI18n, type Language } from "./i18n";
import type { ThemePackSummary } from "./theme/types";

type Props = {
  isOpen: boolean;
  onClose: () => void;

  language: Language;
  onSetLanguage: (language: Language) => void;

  themePackId: string;
  themePacks: ThemePackSummary[];
  onSetThemePackId: (id: string) => void;
  onOpenThemesDir: () => void;
  onImportThemePack: () => void;

  isExplorerVisible: boolean;
  isChatVisible: boolean;
  onToggleExplorer: () => void;
  onToggleChat: () => void;
};

export default function IdeSettingsModal({
  isOpen,
  onClose,
  language,
  onSetLanguage,
  themePackId,
  themePacks,
  onSetThemePackId,
  onOpenThemesDir,
  onImportThemePack,
  isExplorerVisible,
  isChatVisible,
  onToggleExplorer,
  onToggleChat
}: Props) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const languageOptions = useMemo(
    () =>
      [
        { value: "en-US" as const, label: t("languageEnglish") },
        { value: "zh-CN" as const, label: t("languageChinese") }
      ] satisfies Array<{ value: Language; label: string }>,
    [t]
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    queueMicrotask(() => closeButtonRef.current?.focus());
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-6 md:p-10"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-[720px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--vscode-panel-border)] px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-[var(--vscode-foreground)]">{t("ideSettings")}</div>
          </div>
          <button
            ref={closeButtonRef}
            className="rounded px-2 py-1 text-sm text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-6">
          <div className="grid gap-6">
            <div>
              <div className="mb-2 text-sm font-semibold text-[var(--vscode-foreground)]">{t("language")}</div>
              <div className="inline-flex overflow-hidden rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
                {languageOptions.map((opt) => {
                  const active = opt.value === language;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={[
                        "px-3 py-2 text-sm",
                        active
                          ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                          : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                      ].join(" ")}
                      onClick={() => onSetLanguage(opt.value)}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm font-semibold text-[var(--vscode-foreground)]">{t("theme")}</div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  className="min-w-[220px] rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
                  onChange={(e) => onSetThemePackId(e.target.value)}
                  value={themePackId}
                >
                  {(themePacks.length ? themePacks : [{ id: themePackId, name: themePackId, appearance: "dark", source: "builtin" }]).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>

                <button
                  className="rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                  onClick={onImportThemePack}
                  type="button"
                >
                  {t("importThemePack")}
                </button>

                <button
                  className="rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                  onClick={onOpenThemesDir}
                  type="button"
                >
                  {t("openThemesFolder")}
                </button>
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm font-semibold text-[var(--vscode-foreground)]">{t("panels")}</div>
              <div className="grid gap-2">
                <label className="flex items-center gap-2 text-sm text-[var(--vscode-foreground)]">
                  <input checked={isExplorerVisible} className="h-3 w-3" onChange={onToggleExplorer} type="checkbox" />
                  {t("explorer")}
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--vscode-foreground)]">
                  <input checked={isChatVisible} className="h-3 w-3" onChange={onToggleChat} type="checkbox" />
                  {t("chat")}
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
