import React, { useEffect, useMemo, useRef, useState } from "react";
import { messages, useI18n, type Language } from "./i18n";
import { Settings as SettingsIcon } from "lucide-react";
import { createPortal } from "react-dom";

type Props = {
  title?: string;
  centerTitle?: string;
  languageLabel?: string;
  language?: Language;
  onSetLanguage?: (language: Language) => void;
  // Back-compat: if onSetLanguage is not provided, fall back to a simple toggle handler.
  onToggleLanguage?: () => void;
  onOpenSettings?: () => void;
  isExplorerVisible?: boolean;
  isChatVisible?: boolean;
  isTerminalVisible?: boolean;
  onToggleExplorer?: () => void;
  onToggleChat?: () => void;
  onToggleTerminal?: () => void;
  viewMode?: "develop" | "preview" | "review";
  onViewModeChange?: (mode: "develop" | "preview" | "review") => void;
  showExplorerToggle?: boolean;
};

function ToolbarButton({
  title,
  onClick,
  active,
  buttonRef,
  children
}: {
  title: string;
  onClick?: () => void;
  active?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      className={[
        "rounded px-2 py-1 text-[11px] text-[var(--vscode-titleBar-activeForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]",
        active ? "bg-[var(--vscode-toolbar-hoverBackground)]" : ""
      ].join(" ")}
      onClick={onClick}
      type="button"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      title={title}
    >
      {children}
    </button>
  );
}

function IconSidebarLeft({ active }: { active: boolean }) {
  const stroke = active ? "var(--vscode-foreground)" : "var(--vscode-titleBar-activeForeground)";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.2" stroke={stroke} strokeWidth="1.2" />
      <line x1="6" y1="3.6" x2="6" y2="12.4" stroke={stroke} strokeWidth="1.2" />
    </svg>
  );
}

function IconChat({ active }: { active: boolean }) {
  const stroke = active ? "var(--vscode-foreground)" : "var(--vscode-titleBar-activeForeground)";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 3.5h10c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5H8.3L5.3 14v-2.5H3c-.8 0-1.5-.7-1.5-1.5V5c0-.8.7-1.5 1.5-1.5Z"
        stroke={stroke}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <line x1="4.2" y1="6" x2="11.8" y2="6" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
      <line x1="4.2" y1="8.4" x2="10.2" y2="8.4" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconTerminal({ active }: { active: boolean }) {
  const stroke = active ? "var(--vscode-foreground)" : "var(--vscode-titleBar-activeForeground)";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.2" stroke={stroke} strokeWidth="1.2" />
      <path d="M4.5 6.2 6.8 8 4.5 9.8" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="7.8" y1="10.2" x2="11.2" y2="10.2" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconLanguage() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.8 8h10.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M8 2.5c1.9 1.9 3 4 3 5.5s-1.1 3.6-3 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8 2.5c-1.9 1.9-3 4-3 5.5s1.1 3.6 3 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function TitleBar({
  title,
  centerTitle,
  languageLabel,
  language,
  onSetLanguage,
  onToggleLanguage,
  onOpenSettings,
  isExplorerVisible,
  isChatVisible,
  isTerminalVisible,
  onToggleExplorer,
  onToggleChat,
  onToggleTerminal,
  viewMode,
  onViewModeChange,
  showExplorerToggle = true
}: Props) {
  const { t, language: contextLanguage } = useI18n();
  const effectiveTitle = title ?? t("appTitle");
  const ua = navigator.userAgent.toLowerCase();
  const isWindows = ua.includes("windows");
  const isLinux = ua.includes("linux");
  const isMac = ua.includes("mac");
  const showCustomButtons = isWindows || isLinux;
  const canShowLanguageMenu = Boolean(onSetLanguage || onToggleLanguage);
  const currentLanguage = (language ?? contextLanguage) as Language;
  const languageButtonRef = useRef<HTMLButtonElement | null>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [languageMenuStyle, setLanguageMenuStyle] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const [languageQuery, setLanguageQuery] = useState("");

  const languageButtonText = useMemo(() => {
    const base = String(currentLanguage || "").split("-")[0] || String(currentLanguage || "");
    const trimmed = base.trim();
    return trimmed ? trimmed.toUpperCase() : "LANG";
  }, [currentLanguage]);

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
        return { value, label, code: value };
      });
    },
    [t]
  );

  const filteredLanguageOptions = useMemo(() => {
    const q = languageQuery.trim().toLowerCase();
    if (!q) return languageOptions;
    return languageOptions.filter((opt) => opt.value.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q));
  }, [languageOptions, languageQuery]);

  const showLanguageSearch = languageOptions.length >= 6;

  useEffect(() => {
    if (!languageMenuOpen) {
      setLanguageMenuStyle(null);
      setLanguageQuery("");
      return;
    }
    const btn = languageButtonRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const margin = 8;
    const minWidth = Math.max(120, Math.round(r.width));
    const left = Math.min(Math.max(margin, Math.round(r.right - minWidth)), Math.max(margin, window.innerWidth - margin - minWidth));
    const top = Math.round(r.bottom + 6);
    setLanguageMenuStyle({ left, top, minWidth });
  }, [languageMenuOpen]);

  useEffect(() => {
    if (!languageMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLanguageMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [languageMenuOpen]);

  useEffect(() => {
    if (!languageMenuOpen) return;
    setLanguageMenuOpen(false);
  }, [currentLanguage]);

  return (
    <div
      className="flex h-12 items-center justify-between bg-[var(--vscode-titleBar-activeBackground)] backdrop-blur-sm px-4 text-xs text-[var(--vscode-titleBar-activeForeground)] transition-colors duration-300"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-3">
        {/* Modern App Logo & Title */}
        <div className="flex items-center gap-2 select-none opacity-90 hover:opacity-100 transition-opacity">
           <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-purple-500/20 text-white">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
               <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
             </svg>
           </div>
	           {!isMac && (
	             <div className="flex items-baseline gap-2">
	               <span className="font-bold tracking-tight text-sm text-[var(--vscode-titleBar-activeForeground)] font-mono">{effectiveTitle}</span>
	               <span className="rounded bg-[var(--vscode-toolbar-hoverBackground)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--vscode-descriptionForeground)]">BETA</span>
	             </div>
	           )}
	        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center px-4">
        {centerTitle && (
           <span className="min-w-0 truncate text-xs font-medium text-[var(--vscode-titleBar-activeForeground)] opacity-80">
            {centerTitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {onViewModeChange && viewMode ? (
          <div className="mr-1 flex items-center rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-0.5">
            <button
              className={[
                "rounded px-2 py-1 text-[11px]",
                viewMode === "develop"
                  ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                  : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
              ].join(" ")}
              onClick={() => onViewModeChange("develop")}
              type="button"
              title={t("developMode")}
            >
              {t("dev")}
            </button>
            <button
              className={[
                "rounded px-2 py-1 text-[11px]",
                viewMode === "preview"
                  ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                  : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
              ].join(" ")}
              onClick={() => onViewModeChange("preview")}
              type="button"
              title={t("previewMode")}
            >
              {t("preview")}
            </button>
            <button
              className={[
                "rounded px-2 py-1 text-[11px]",
                viewMode === "review"
                  ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                  : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
              ].join(" ")}
              onClick={() => onViewModeChange("review")}
              type="button"
              title={t("reviewMode")}
            >
              {t("review")}
            </button>
          </div>
        ) : null}

        {showExplorerToggle ? (
          <ToolbarButton title={t("toggleExplorer")} onClick={onToggleExplorer} active={Boolean(isExplorerVisible)}>
            <IconSidebarLeft active={Boolean(isExplorerVisible)} />
          </ToolbarButton>
        ) : null}
        <ToolbarButton title={t("toggleChat")} onClick={onToggleChat} active={Boolean(isChatVisible)}>
          <IconChat active={Boolean(isChatVisible)} />
        </ToolbarButton>
        <ToolbarButton title={t("toggleTerminal")} onClick={onToggleTerminal} active={Boolean(isTerminalVisible)}>
          <IconTerminal active={Boolean(isTerminalVisible)} />
        </ToolbarButton>
        {onOpenSettings ? (
          <ToolbarButton title={t("ideSettings")} onClick={onOpenSettings}>
            <SettingsIcon className="h-4 w-4" />
          </ToolbarButton>
        ) : null}
        {canShowLanguageMenu ? (
          <>
            <ToolbarButton
              title={t("toggleLanguage")}
              onClick={() => {
                if (!onSetLanguage) {
                  onToggleLanguage?.();
                  return;
                }
                setLanguageMenuOpen((v) => !v);
              }}
              buttonRef={languageButtonRef}
            >
              <span className="inline-flex items-center gap-1">
                <span className="text-[var(--vscode-titleBar-activeForeground)]">
                  <IconLanguage />
                </span>
                <span className="text-[11px] text-[var(--vscode-titleBar-activeForeground)]">{languageButtonText}</span>
                <span className="text-[11px] text-[var(--vscode-descriptionForeground)]">▾</span>
              </span>
            </ToolbarButton>

            {languageMenuOpen && languageMenuStyle
              ? createPortal(
                  <div
                    className="fixed inset-0 z-[9999]"
                    onMouseDown={(e) => {
                      if (e.target === e.currentTarget) setLanguageMenuOpen(false);
                    }}
                  >
                    <div
                      className="fixed overflow-hidden rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-lg"
                      style={{ left: languageMenuStyle.left, top: languageMenuStyle.top, minWidth: languageMenuStyle.minWidth }}
                      role="menu"
                    >
                      <div className="px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("toggleLanguage")}</div>
                      {showLanguageSearch ? (
                        <div className="border-t border-[var(--vscode-panel-border)] p-2">
                          <input
                            className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                            placeholder="Search language"
                            value={languageQuery}
                            onChange={(e) => setLanguageQuery(e.target.value)}
                          />
                        </div>
                      ) : null}
                      <div className="max-h-[320px] overflow-auto py-1">
                        {filteredLanguageOptions.map((opt) => {
                          const selected = opt.value === currentLanguage;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              role="menuitem"
                              className={[
                                "flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left text-[12px]",
                                "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]",
                                selected ? "bg-black/10" : ""
                              ].join(" ")}
                              onClick={() => {
                                setLanguageMenuOpen(false);
                                onSetLanguage?.(opt.value);
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                <span>{opt.label}</span>
                                {opt.label !== opt.code ? (
                                  <span className="ml-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{opt.code}</span>
                                ) : null}
                              </span>
                              {selected ? (
                                <span className="text-[11px] text-[var(--vscode-descriptionForeground)]">✓</span>
                              ) : (
                                <span className="w-3" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>,
                  document.body
                )
              : null}
          </>
        ) : null}

	        {showCustomButtons ? (
	          <div className="ml-3 flex items-center gap-1">
	            <button
	              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-titleBar-activeForeground)] opacity-70 hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:opacity-100 transition-colors"
	              onClick={() => void window.xcoding.window.minimize()}
	              title={t("windowMinimize")}
	              type="button"
	            >
              <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><rect width="10" height="1" rx="0.5"/></svg>
	            </button>
	            <button
	              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-titleBar-activeForeground)] opacity-70 hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:opacity-100 transition-colors"
	              onClick={() => void window.xcoding.window.maximizeToggle()}
	              title={t("windowMaximize")}
	              type="button"
	            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>
	            </button>
	            <button
	              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-titleBar-activeForeground)] opacity-70 hover:bg-red-500/90 hover:text-white hover:opacity-100 transition-colors"
	              onClick={() => void window.xcoding.window.close()}
	              title={t("windowClose")}
	              type="button"
	            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
