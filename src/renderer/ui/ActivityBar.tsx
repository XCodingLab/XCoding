import React from "react";
import { Copy, MessageSquare, Settings, TerminalSquare } from "lucide-react";
import { useI18n } from "./i18n";

type Props = {
  isExplorerVisible: boolean;
  isChatVisible: boolean;
  isTerminalVisible: boolean;
  onToggleExplorer: () => void;
  onToggleChat: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
};

function ActivityBarItem({
  title,
  active,
  onClick,
  icon
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      className={[
        "group relative flex h-12 w-12 items-center justify-center focus:outline-none",
        active
          ? "text-[var(--vscode-activityBar-foreground)]"
          : "text-[var(--vscode-activityBar-inactiveForeground)] hover:text-[var(--vscode-activityBar-foreground)]"
      ].join(" ")}
      onClick={onClick}
      title={title}
      type="button"
    >
      {active && <div className="absolute bottom-0 left-0 top-0 w-[2px] bg-[var(--vscode-activityBar-activeBorder)]" />}
      {icon}
    </button>
  );
}

export default function ActivityBar({
  isExplorerVisible,
  isChatVisible,
  isTerminalVisible,
  onToggleExplorer,
  onToggleChat,
  onToggleTerminal,
  onOpenSettings
}: Props) {
  const { t } = useI18n();

  return (
    <div className="flex w-[48px] shrink-0 flex-col items-center border-r border-[var(--vscode-activityBar-border)] bg-[var(--vscode-activityBar-background)] py-2">
      <ActivityBarItem
        title={t("explorer")}
        active={isExplorerVisible}
        onClick={onToggleExplorer}
        icon={<Copy className="h-6 w-6 stroke-[1.5]" />}
      />

      <ActivityBarItem
        title={t("chat")}
        active={isChatVisible}
        onClick={onToggleChat}
        icon={<MessageSquare className="h-6 w-6 stroke-[1.5]" />}
      />

      <ActivityBarItem
        title={t("terminal")}
        active={isTerminalVisible}
        onClick={onToggleTerminal}
        icon={<TerminalSquare className="h-6 w-6 stroke-[1.5]" />}
      />

      <div className="flex-1" />

      <ActivityBarItem title={t("settings")} active={false} onClick={onOpenSettings} icon={<Settings className="h-6 w-6 stroke-[1.5]" />} />
    </div>
  );
}
