import { useEffect, useMemo, useRef } from "react";
import { messages, useI18n, type Language } from "./i18n";
import { useUiTheme } from "./UiThemeContext";
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

  autoSave: "off" | "afterDelay";
  autoSaveDelayMs: number;
  onSetAutoSave: (autoSave: "off" | "afterDelay", autoSaveDelayMs: number) => void;
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
  autoSave,
  autoSaveDelayMs,
  onSetAutoSave
}: Props) {
  const { t } = useI18n();
  const { theme: uiTheme } = useUiTheme();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const languageOptions = useMemo(
    () => {
      const knownLabel = (lang: Language) => {
        if (lang === "en-US") return t("languageEnglish");
        if (lang === "zh-CN") return t("languageChinese");
        return "";
      };
      const codes = (Object.keys(messages) as Language[]).slice().sort((a, b) => a.localeCompare(b));
      return codes.map((value) => {
        const label = knownLabel(value) || value;
        const display = label === value ? label : `${label} (${value})`;
        return { value, label: display };
      });
    },
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 md:p-10"
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
              <select
                className="min-w-[220px] rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
                onChange={(e) => onSetLanguage(e.target.value as Language)}
                value={language}
              >
                {languageOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-2 text-sm font-semibold text-[var(--vscode-foreground)]">{t("theme")}</div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  className="min-w-[220px] rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
                  onChange={(e) => onSetThemePackId(e.target.value)}
                  value={themePackId}
                >
                  {(themePacks.length
                    ? themePacks
                    : [
                        {
                          id: themePackId,
                          name: themePackId,
                          appearance: uiTheme,
                          source: themePackId.startsWith("builtin-") ? "builtin" : "user"
                        }
                      ]
                  ).map((t) => (
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
              <div className="mb-2 text-sm font-semibold text-[var(--vscode-foreground)]">{t("autoSave")}</div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  className="min-w-[220px] rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
                  onChange={(e) => onSetAutoSave(e.target.value as any, autoSaveDelayMs)}
                  value={autoSave}
                >
                  <option value="off">{t("autoSaveOff")}</option>
                  <option value="afterDelay">{t("autoSaveAfterDelay")}</option>
                </select>

                <div className="flex items-center gap-2 text-sm text-[var(--vscode-descriptionForeground)]">
                  <span>{t("autoSaveDelay")}</span>
                  <input
                    className="w-[110px] rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2 text-sm text-[var(--vscode-foreground)] outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                    type="number"
                    min={200}
                    max={60_000}
                    step={100}
                    value={autoSaveDelayMs}
                    onChange={(e) => onSetAutoSave(autoSave, Number(e.target.value))}
                    disabled={autoSave !== "afterDelay"}
                  />
                  <span className="text-[var(--vscode-descriptionForeground)]">ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
