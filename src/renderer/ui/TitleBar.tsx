import React from "react";
import { useI18n } from "./i18n";

type Props = {
  title?: string;
  centerTitle?: string;
  languageLabel?: string;
  onToggleLanguage?: () => void;
  isExplorerVisible?: boolean;
  isChatVisible?: boolean;
  isTerminalVisible?: boolean;
  onToggleExplorer?: () => void;
  onToggleChat?: () => void;
  onToggleTerminal?: () => void;
  viewMode?: "develop" | "preview";
  onViewModeChange?: (mode: "develop" | "preview") => void;
  showExplorerToggle?: boolean;
};

function ToolbarButton({
  title,
  onClick,
  active,
  children
}: {
  title: string;
  onClick?: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
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

export default function TitleBar({
  title,
  centerTitle,
  languageLabel,
  onToggleLanguage,
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
  const { t } = useI18n();
  const effectiveTitle = title ?? t("appTitle");
  const ua = navigator.userAgent.toLowerCase();
  const isWindows = ua.includes("windows");
  const isLinux = ua.includes("linux");
  const isMac = ua.includes("mac");
  const showCustomButtons = isWindows || isLinux;
  return (
    <div
      className="flex h-10 items-center justify-between border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-titleBar-activeBackground)] px-2 text-xs text-[var(--vscode-titleBar-activeForeground)]"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isMac ? null : <div className="min-w-0 truncate text-[11px] text-[var(--vscode-titleBar-activeForeground)]">{effectiveTitle}</div>}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center px-2">
        <div className="min-w-0 truncate text-[11px] font-medium text-[var(--vscode-titleBar-activeForeground)]">
          {centerTitle ?? ""}
        </div>
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
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
        {onToggleLanguage ? (
          <ToolbarButton title={t("toggleLanguage")} onClick={onToggleLanguage}>
            {languageLabel ?? t("languageToggleDefault")}
          </ToolbarButton>
        ) : null}

        {showCustomButtons ? (
          <div className="ml-2 flex items-stretch overflow-hidden rounded border border-[var(--vscode-panel-border)]">
            <button
              className="flex h-7 w-10 items-center justify-center text-[12px] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              onClick={() => void window.xcoding.window.minimize()}
              title={t("windowMinimize")}
              type="button"
            >
              —
            </button>
            <button
              className="flex h-7 w-10 items-center justify-center text-[12px] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              onClick={() => void window.xcoding.window.maximizeToggle()}
              title={t("windowMaximize")}
              type="button"
            >
              {isWindows ? "▢" : "⬜"}
            </button>
            <button
              className="flex h-7 w-10 items-center justify-center text-[12px] hover:bg-red-500/80 hover:text-white"
              onClick={() => void window.xcoding.window.close()}
              title={t("windowClose")}
              type="button"
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
