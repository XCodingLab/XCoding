import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "./i18n";
import TerminalView from "./TerminalView";
import CodexPanel from "./CodexPanel";

type ChatMessage = { role: "user" | "assistant"; content: string };

type AgentView = "chat" | "claude" | "codex";
type AgentCliState = {
  claude: { tabId: string; sessionId?: string; hasStarted: boolean };
  codex: { tabId: string; sessionId?: string; hasStarted: boolean };
};

type Props = {
  slot: number;
  isVisible: boolean;
  width?: number;
  onClose: () => void;

  projectRootPath?: string;
  terminalScrollback?: number;
  onOpenUrl: (url: string) => void;
  onOpenImage: (absPathOrUrl: string) => void;
  onOpenFile: (relPath: string, line?: number, column?: number) => void;

  agentView: AgentView;
  setAgentView: (next: AgentView) => void;
  allowedAgentViews?: AgentView[];
  agentCli: AgentCliState;
  updateAgentCli: (updater: (prev: AgentCliState) => AgentCliState) => void;

  aiConfig: { apiBase: string; apiKey: string; model: string };
  setAiConfig: (next: { apiBase: string; apiKey: string; model: string }) => void;
  autoApplyAll: boolean;
  setAutoApplyAll: (next: boolean) => void;

  chatInput: string;
  setChatInput: (next: string) => void;
  chatMessages: ChatMessage[];
  activeRequestId: string | null;
  onSend: () => void;
  onStop: () => void;

  stagedFiles: string[];
  onOpenDiff: (path: string) => void;
  onApplyAll: () => void;
  onRevertLast: () => void;
};

export default function ChatPanel({
  slot,
  isVisible,
  width,
  onClose,
  projectRootPath,
  terminalScrollback = 1500,
  onOpenUrl,
  onOpenImage,
  onOpenFile,
  agentView,
  setAgentView,
  allowedAgentViews,
  agentCli,
  updateAgentCli,
  aiConfig,
  setAiConfig,
  autoApplyAll,
  setAutoApplyAll,
  chatInput,
  setChatInput,
  chatMessages,
  activeRequestId,
  onSend,
  onStop,
  stagedFiles,
  onOpenDiff,
  onApplyAll,
  onRevertLast
}: Props) {
  const { t } = useI18n();
  const [showSettings, setShowSettings] = useState(false);

  const allowed = useMemo(() => {
    return ((allowedAgentViews && allowedAgentViews.length ? allowedAgentViews : (["chat", "claude", "codex"] as const)) as AgentView[]).slice();
  }, [allowedAgentViews]);
  const safeAgentView: AgentView = useMemo(() => (allowed.includes(agentView) ? agentView : allowed[0] ?? "chat"), [allowed, agentView]);
  const title = "";

  const paneClass = (active: boolean) =>
    [
      "absolute inset-0 min-h-0",
      active ? "" : "pointer-events-none opacity-0",
      "transition-opacity"
    ].join(" ");

  const activeCli =
    safeAgentView === "claude" ? { key: "claude" as const, label: t("claudeCode"), command: "claude", state: agentCli.claude } : null;

  function resetCliSession(key: "claude" | "codex") {
    const existing = key === "claude" ? agentCli.claude.sessionId : agentCli.codex.sessionId;
    if (existing) void window.xcoding.terminal.dispose(existing);
    updateAgentCli((prev) => ({
      ...prev,
      [key]: { tabId: `agent-${key}-${Date.now()}-${Math.random().toString(16).slice(2)}`, sessionId: undefined, hasStarted: false }
    }));
  }

  return (
    <aside
      className={[
        "flex h-full w-full min-h-0 shrink-0 flex-col border-l border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]",
        isVisible ? "" : "pointer-events-none opacity-0"
      ].join(" ")}
      style={width ? ({ width } as React.CSSProperties) : undefined}
    >
      <div className="flex h-10 items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2">
        <div className="flex min-w-0 items-center gap-2">
          {allowed.length > 1 ? <div className="flex items-center gap-1">
            {allowed.includes("chat") ? (
              <button
                className={[
                  "rounded px-2 py-1 text-[11px]",
                  safeAgentView === "chat"
                    ? "bg-[var(--vscode-sideBarSectionHeader-background)] text-[var(--vscode-foreground)]"
                    : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                ].join(" ")}
                onClick={() => setAgentView("chat")}
                type="button"
                title={t("chatTab")}
              >
                {t("chat")}
              </button>
            ) : null}
            {allowed.includes("claude") ? (
              <button
                className={[
                  "rounded px-2 py-1 text-[11px]",
                  safeAgentView === "claude"
                    ? "bg-[var(--vscode-sideBarSectionHeader-background)] text-[var(--vscode-foreground)]"
                    : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                ].join(" ")}
                onClick={() => {
                  setShowSettings(false);
                  setAgentView("claude");
                }}
                type="button"
                title={t("claudeCode")}
              >
                {t("claude")}
              </button>
            ) : null}
            {allowed.includes("codex") ? (
              <button
                className={[
                  "rounded px-2 py-1 text-[11px]",
                  safeAgentView === "codex"
                    ? "bg-[var(--vscode-sideBarSectionHeader-background)] text-[var(--vscode-foreground)]"
                    : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                ].join(" ")}
                onClick={() => {
                  setShowSettings(false);
                  setAgentView("codex");
                }}
                type="button"
                title={t("codex")}
              >
                Codex
              </button>
            ) : null}
          </div> : null}
        </div>
        <div className="flex items-center gap-1">
          {activeCli ? (
            <button
              className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              onClick={() => resetCliSession(activeCli.key)}
              type="button"
              title={t("newSession")}
            >
              <Plus className="h-4 w-4" />
            </button>
          ) : null}
          {safeAgentView === "chat" ? (
            <button
              className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              onClick={() => setShowSettings((v) => !v)}
              type="button"
              title={t("settings")}
            >
              ⚙
            </button>
          ) : null}
          <button
            className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={onClose}
            type="button"
            title={t("close")}
          >
            ×
          </button>
        </div>
      </div>

      {showSettings && safeAgentView === "chat" ? (
        <div className="border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
          <div className="mb-2 text-[11px] font-semibold text-[var(--vscode-foreground)]">{t("aiSettings")}</div>
          <div className="grid gap-2">
            <input
              className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
              placeholder={t("apiBase")}
              value={aiConfig.apiBase}
              onChange={(e) => setAiConfig({ ...aiConfig, apiBase: e.target.value })}
            />
            <input
              className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
              placeholder={t("apiKey")}
              value={aiConfig.apiKey}
              onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
            />
            <input
              className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
              placeholder={t("model")}
              value={aiConfig.model}
              onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
            />
            <label className="flex items-center gap-2 text-[12px] text-[var(--vscode-foreground)]">
              <input checked={autoApplyAll} className="h-3 w-3" onChange={(e) => setAutoApplyAll(e.target.checked)} type="checkbox" />
              {t("autoApplyAll")}
            </label>
          </div>
        </div>
      ) : null}

      {/* Keep all panes mounted; hide via opacity (NOT display:none) so Codex layout measurements stay correct. */}
      <div className="relative min-h-0 flex-1">
        <div className={paneClass(safeAgentView === "codex")}>
          <CodexPanel slot={slot} projectRootPath={projectRootPath} onOpenUrl={onOpenUrl} onOpenImage={onOpenImage} />
        </div>

        <div className={paneClass(safeAgentView === "claude")}>
          <div className="h-full min-h-0 p-2">
            {activeCli ? (
              <TerminalView
                key={activeCli.state.tabId}
                tabId={activeCli.state.tabId}
                sessionId={activeCli.state.sessionId}
                onSessionId={(sessionId) => {
                  updateAgentCli((prev) => ({
                    ...prev,
                    [activeCli.key]: { ...prev[activeCli.key], sessionId }
                  }));
                }}
                initialCommand={activeCli.state.hasStarted ? undefined : activeCli.command}
                onDidRunInitialCommand={() => {
                  updateAgentCli((prev) => ({
                    ...prev,
                    [activeCli.key]: { ...prev[activeCli.key], hasStarted: true }
                  }));
                }}
                isActive={safeAgentView === "claude"}
                isPaused={false}
                scrollback={terminalScrollback}
                slot={slot}
                projectRootPath={projectRootPath}
                onOpenUrl={onOpenUrl}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </div>
        </div>

        <div className={paneClass(safeAgentView === "chat")}>
          <div className="h-full min-h-0 overflow-auto p-2">
            {chatMessages.length === 0 ? (
              <div className="rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
                {t("chatPlaceholder")}
              </div>
            ) : (
              chatMessages.map((m, idx) => (
                <div key={idx} className="mb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{m.role}</div>
                  <div className="whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2 text-sm text-[var(--vscode-foreground)]">
                    {m.content}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {safeAgentView === "chat" ? (
        <div className="border-t border-[var(--vscode-panel-border)] p-2">
        <div className="mb-2 flex flex-wrap gap-2">
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={onApplyAll}
            type="button"
          >
            {t("applyAll")}
          </button>
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={onRevertLast}
            type="button"
          >
            {t("revertLast")}
          </button>
          {activeRequestId ? (
            <button
              className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
              onClick={onStop}
              type="button"
            >
              {t("stop")}
            </button>
          ) : null}
        </div>

        {stagedFiles.length ? (
          <div className="mb-2 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
            <div className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-[11px] font-semibold text-[var(--vscode-foreground)]">
              {t("staging")}
            </div>
            <div className="max-h-40 overflow-auto p-1">
              {stagedFiles.map((p) => (
                <button
                  key={p}
                  className="block w-full truncate rounded px-2 py-1 text-left text-[11px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                  onClick={() => onOpenDiff(p)}
                  type="button"
                  title={p}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-2 py-1 text-sm text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
            placeholder={t("ask")}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend();
            }}
          />
          <button
            className="rounded bg-[var(--vscode-button-background)] px-3 py-1 text-sm text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
            disabled={!chatInput.trim()}
            onClick={onSend}
            type="button"
          >
            {t("send")}
          </button>
        </div>
        </div>
      ) : null}
    </aside>
  );
}
