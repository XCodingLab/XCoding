import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../ui/i18n";
import { applyClaudeStreamEvent, createClaudeStore, type ClaudeEventEnvelope, type ClaudeStore, type ClaudeUiMessage } from "./store/claudeStore";
import { persistMode, safeLoadMode, type ClaudePermissionMode } from "./panel/types";

type Props = {
  slot: number;
  projectRootPath?: string;
  onOpenUrl: (url: string) => void;
  isActive?: boolean;
};

type ClaudeSessionReadResult = Awaited<ReturnType<Window["xcoding"]["claude"]["sessionRead"]>>;

function modeLabel(mode: ClaudePermissionMode) {
  switch (mode) {
    case "default":
      return "default";
    case "acceptEdits":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "bypassPermissions";
    default:
      return "default";
  }
}

export default function ClaudePanel({ slot, projectRootPath, onOpenUrl, isActive }: Props) {
  const { t } = useI18n();
  const isPanelActive = isActive !== false;
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<ClaudePermissionMode>("default");
  const [input, setInput] = useState("");
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<Array<{ sessionId: string; updatedAtMs: number }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<Array<{ name: string; status: string }>>([]);
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null);
  const [diffFiles, setDiffFiles] = useState<Array<{ absPath: string; backupName: string }>>([]);
  const [diffSelectedAbsPath, setDiffSelectedAbsPath] = useState<string>("");
  const [diffState, setDiffState] = useState<{ loading: boolean; original: string; modified: string; error?: string }>({
    loading: false,
    original: "",
    modified: ""
  });
  const storeRef = useRef<ClaudeStore>(createClaudeStore());
  const scheduledRafRef = useRef<number | null>(null);
  const hydratedModeRef = useRef(false);

  const projectKey = useMemo(() => `${String(slot)}:${projectRootPath ? String(projectRootPath) : ""}`, [slot, projectRootPath]);

  const bump = useCallback(() => {
    if (scheduledRafRef.current != null) return;
    scheduledRafRef.current = window.requestAnimationFrame(() => {
      scheduledRafRef.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (hydratedModeRef.current && (!projectRootPath || !projectRootPath.trim())) return;
    hydratedModeRef.current = true;
    setMode(safeLoadMode(projectKey));
  }, [projectKey, projectRootPath]);

  useEffect(() => {
    const offEvent = window.xcoding.claude.onEvent((payload: any) => {
      const env = payload as ClaudeEventEnvelope;
      if (env?.slot !== slot) return;
      if (env.kind === "status") storeRef.current.status = env.status;
      if (env.kind === "stderr") storeRef.current.stderr.push({ at: Date.now(), text: String(env.text ?? "") });
      if (env.kind === "log") storeRef.current.logs.unshift({ at: Date.now(), message: String(env.message ?? ""), data: env.data });
      if (env.kind === "stream") applyClaudeStreamEvent(storeRef.current, env.event);
      bump();
    });
    const offReq = window.xcoding.claude.onRequest((payload: any) => {
      if (payload?.slot !== undefined && Number(payload.slot) !== slot) return;
      storeRef.current.approvals.unshift({
        at: Date.now(),
        requestId: String(payload.requestId ?? ""),
        sessionId: String(payload.sessionId ?? ""),
        toolName: String(payload.toolName ?? ""),
        toolInput: payload.toolInput,
        suggestions: payload.suggestions,
        toolUseId: payload.toolUseId ? String(payload.toolUseId) : undefined
      });
      setPendingApprovalId(String(payload.requestId ?? ""));
      bump();
    });
    return () => {
      offEvent();
      offReq();
    };
  }, [bump, slot]);

  useEffect(() => {
    if (!isPanelActive) return;
    if (!projectRootPath || !projectRootPath.trim()) return;
    void window.xcoding.claude.ensureStarted({ slot, projectRootPath, permissionMode: mode });
  }, [isPanelActive, mode, projectRootPath, slot]);

  const refreshHistory = useCallback(async () => {
    if (!projectRootPath) return;
    setHistoryLoading(true);
    try {
      const res = await window.xcoding.claude.historyList({ projectRootPath });
      if (res?.ok && Array.isArray(res.sessions)) {
        setHistorySessions(
          res.sessions.map((s: any) => ({ sessionId: String(s.sessionId ?? ""), updatedAtMs: Number(s.updatedAtMs ?? 0) })).filter((s: any) => s.sessionId)
        );
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [projectRootPath]);

  const refreshMcpStatus = useCallback(async () => {
    const res = await window.xcoding.claude.mcpServerStatus({ slot });
    if (res?.ok && Array.isArray(res.servers)) {
      setMcpStatus(res.servers.map((s: any) => ({ name: String(s.name ?? ""), status: String(s.status ?? "") })));
    }
  }, [slot]);

  const loadHistorySession = useCallback(
    async (sessionId: string) => {
      if (!projectRootPath) return;
      setHistoryLoading(true);
      try {
        // Read history first so the UI isn't blocked by resume/startup.
        const res = await Promise.race<ClaudeSessionReadResult>([
          window.xcoding.claude.sessionRead({ projectRootPath, sessionId }),
          new Promise<ClaudeSessionReadResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: "sessionRead_timeout" }), 8000))
        ]);
        if (!res?.ok || !res.thread?.turns) {
          storeRef.current.messages.unshift({
            id: `err-${Date.now()}`,
            role: "system",
            text: `Failed to load session: ${String(res?.reason ?? "unknown")}`
          });
          bump();
          return;
        }
        const turnsArr = res.thread.turns as any[];
        if (!turnsArr.length) {
          storeRef.current.messages.unshift({
            id: `err-${Date.now()}`,
            role: "system",
            text: "Session file has no chat messages."
          });
          bump();
          return;
        }
        storeRef.current.messages = [];
        let added = 0;
        for (const turn of turnsArr) {
          if (Array.isArray(turn.toolEvents) && turn.toolEvents.length) {
            for (const te of turn.toolEvents as any[]) {
              if (te.kind === "tool_use") {
                storeRef.current.messages.push({
                  id: `htu-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                  role: "system",
                  text: `tool_use: ${String(te.name ?? "tool")}\n${JSON.stringify(te.input ?? {}, null, 2)}`
                });
                added += 1;
              } else if (te.kind === "tool_result") {
                storeRef.current.messages.push({
                  id: `htr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                  role: "system",
                  text: `tool_result${te.toolUseId ? ` (${te.toolUseId})` : ""}${te.isError ? " [error]" : ""}:\n${String(te.content ?? "")}`
                });
                added += 1;
              }
            }
          }
          if (turn.user?.text)
            (storeRef.current.messages.push({ id: `hu-${turn.id}`, role: "user", text: String(turn.user.text), meta: { uuid: turn.user?.uuid } }), (added += 1));
          if (turn.assistant?.text)
            storeRef.current.messages.push({
              id: `ha-${turn.id}`,
              role: "assistant",
              text: String(turn.assistant.text),
              meta: { uuid: turn.assistant?.uuid, assistantMessageId: turn.assistant?.assistantMessageId }
            });
          if (turn.assistant?.text) added += 1;
        }
        storeRef.current.messages.unshift({
          id: `hist-${Date.now()}`,
          role: "system",
          text: `Loaded history (${added} messages) from ${String(res.thread?.debug?.sourcePath ?? "unknown")}`
        });
        setDiffSessionId(sessionId);
        setDiffFiles([]);
        setDiffSelectedAbsPath("");
        bump();
        setIsHistoryOpen(false);

        // Then try to resume this session in the background. Timeout so UI doesn't get stuck.
        void (async () => {
          try {
            await window.xcoding.claude.close({ slot });
            await Promise.race([
              window.xcoding.claude.ensureStarted({ slot, projectRootPath, sessionId, permissionMode: mode }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("ensureStarted_timeout")), 8000))
            ]);
          } catch (e) {
            storeRef.current.messages.unshift({
              id: `warn-${Date.now()}`,
              role: "system",
              text: `Resume session failed (history is still loaded): ${e instanceof Error ? e.message : String(e)}`
            });
            bump();
          }
        })();
      } finally {
        setHistoryLoading(false);
      }
    },
    [bump, mode, projectRootPath, slot]
  );

  const forkHistorySession = useCallback(
    async (baseSessionId: string) => {
      if (!projectRootPath) return;
      setHistoryLoading(true);
      try {
        const res = await window.xcoding.claude.forkSession({ slot, projectRootPath, sessionId: baseSessionId, permissionMode: mode });
        if (res?.ok && typeof res.sessionId === "string" && res.sessionId) {
          await loadHistorySession(String(res.sessionId));
        }
      } finally {
        setHistoryLoading(false);
      }
    },
    [loadHistorySession, mode, projectRootPath, slot]
  );

  const refreshDiffFiles = useCallback(async () => {
    if (!projectRootPath || !diffSessionId) return;
    const res = await window.xcoding.claude.latestSnapshotFiles({ projectRootPath, sessionId: diffSessionId });
    if (res?.ok && Array.isArray(res.files)) {
      setDiffFiles(res.files.map((f: any) => ({ absPath: String(f.absPath ?? ""), backupName: String(f.backupName ?? "") })).filter((f: any) => f.absPath));
    }
  }, [diffSessionId, projectRootPath]);

  const loadDiffForFile = useCallback(
    async (absPath: string) => {
      if (!projectRootPath || !diffSessionId) return;
      setDiffSelectedAbsPath(absPath);
      setDiffState((s) => ({ ...s, loading: true, error: undefined }));
      const res = await window.xcoding.claude.turnFileDiff({ projectRootPath, sessionId: diffSessionId, absPath });
      if (res?.ok) {
        setDiffState({ loading: false, original: String(res.original ?? ""), modified: String(res.modified ?? "") });
      } else {
        setDiffState({ loading: false, original: "", modified: "", error: String(res?.reason ?? "diff_failed") });
      }
    },
    [diffSessionId, projectRootPath]
  );

  const messages = storeRef.current.messages;
  const approvals = storeRef.current.approvals;
  const status = storeRef.current.status;
  const logs = storeRef.current.logs;
  const stderr = storeRef.current.stderr;
  const activeApproval = pendingApprovalId ? approvals.find((a) => a.requestId === pendingApprovalId) ?? null : null;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    const msg: ClaudeUiMessage = { id: `u-${Date.now()}`, role: "user", text };
    storeRef.current.messages.push(msg);
    bump();
    setInput("");
    await window.xcoding.claude.ensureStarted({ slot, projectRootPath: projectRootPath || "", permissionMode: mode });
    await window.xcoding.claude.sendUserMessage({ slot, content: text });
  }, [bump, input, mode, projectRootPath, slot]);

  const setModeAndPersist = useCallback(
    async (next: ClaudePermissionMode) => {
      if (next === "bypassPermissions") {
        const ok = window.confirm(
          "bypassPermissions 会跳过所有权限提示（YOLO/full access）。\\n\\n仅在你信任当前项目内容和环境时使用。是否继续？"
        );
        if (!ok) return;
      }
      setMode(next);
      persistMode(projectKey, next);
      await window.xcoding.claude.setPermissionMode({ slot, mode: next });
    },
    [projectKey, slot]
  );

  const respondApproval = useCallback(
    async (behavior: "allow" | "deny", forSession: boolean) => {
      if (!activeApproval) return;
      await window.xcoding.claude.respondToolPermission({
        requestId: activeApproval.requestId,
        behavior,
        updatedInput: activeApproval.toolInput,
        updatedPermissions: behavior === "allow" && forSession ? activeApproval.suggestions : undefined,
        interrupt: behavior === "deny"
      });
      setPendingApprovalId(null);
    },
    [activeApproval]
  );

  // re-render dependency
  void version;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--vscode-sideBar-background)]">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2">
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">{t("claudeCode")}</div>
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={() => {
              setIsHistoryOpen((v) => !v);
              void refreshHistory();
              void refreshMcpStatus();
            }}
            type="button"
          >
            History
          </button>
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={() => {
              const ok = window.confirm("Start a new Claude session? (This will close the current one)");
              if (!ok) return;
              storeRef.current.messages = [];
              storeRef.current.approvals = [];
              setPendingApprovalId(null);
              bump();
              void window.xcoding.claude.close({ slot }).then(() => {
                if (projectRootPath) void window.xcoding.claude.ensureStarted({ slot, projectRootPath, permissionMode: mode });
              });
            }}
            type="button"
          >
            New
          </button>
          <select
            className="rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[11px] text-[var(--vscode-input-foreground)] ring-1 ring-[var(--vscode-input-border)]"
            value={mode}
            onChange={(e) => void setModeAndPersist(e.target.value as ClaudePermissionMode)}
          >
            <option value="default">{modeLabel("default")}</option>
            <option value="acceptEdits">{modeLabel("acceptEdits")}</option>
            <option value="plan">{modeLabel("plan")}</option>
            <option value="bypassPermissions">{modeLabel("bypassPermissions")}</option>
          </select>
          <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">{status?.state ?? "idle"}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={() => void window.xcoding.claude.interrupt({ slot })}
            type="button"
          >
            {t("stop")}
          </button>
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={() => void window.xcoding.claude.close({ slot })}
            type="button"
          >
            {t("windowClose")}
          </button>
        </div>
      </div>

      {activeApproval ? (
        <div className="border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
          <div className="mb-1 text-[11px] font-semibold text-[var(--vscode-foreground)]">Permission request</div>
          <div className="mb-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
            <span className="font-semibold">{activeApproval.toolName}</span>
          </div>
          <pre className="max-h-40 overflow-auto rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2 text-[10px] text-[var(--vscode-foreground)]">
            {JSON.stringify(activeApproval.toolInput ?? null, null, 2)}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
              onClick={() => void respondApproval("allow", false)}
              type="button"
            >
              Allow once
            </button>
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              onClick={() => void respondApproval("allow", true)}
              type="button"
              title="Apply suggested permission updates for this session"
            >
              Allow for session
            </button>
            <button
              className="rounded bg-[var(--vscode-errorForeground)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)]"
              onClick={() => void respondApproval("deny", false)}
              type="button"
            >
              Deny
            </button>
          </div>
          <div className="mt-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
            Tip: if you don’t respond, the request will time out and be denied (fail-closed).
          </div>
        </div>
      ) : null}

      {(status?.state === "error" || stderr.length || logs.length) ? (
        <div className="border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
          <div className="mb-1 text-[11px] font-semibold text-[var(--vscode-foreground)]">Debug</div>
          {status?.state === "error" ? (
            <div className="mb-2 text-[11px] text-[var(--vscode-errorForeground)]">{String(status?.error ?? "error")}</div>
          ) : null}
          {stderr.length ? (
            <pre className="mb-2 max-h-24 overflow-auto rounded border border-[var(--vscode-panel-border)] p-2 text-[10px] text-[var(--vscode-errorForeground)]">
              {stderr.slice(-5).map((s) => s.text).join("")}
            </pre>
          ) : null}
          {logs.length ? (
            <pre className="max-h-24 overflow-auto rounded border border-[var(--vscode-panel-border)] p-2 text-[10px] text-[var(--vscode-foreground)]">
              {logs
                .slice(0, 10)
                .map((l) => `${new Date(l.at).toISOString()} ${l.message}${l.data !== undefined ? " " + JSON.stringify(l.data) : ""}`)
                .join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}

      {isHistoryOpen ? (
        <div className="border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">Sessions</div>
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              onClick={() => void refreshHistory()}
              type="button"
              disabled={historyLoading}
            >
              {historyLoading ? t("loading") : "Refresh"}
            </button>
          </div>
          {!projectRootPath ? (
            <div className="mb-2 text-[11px] text-[var(--vscode-descriptionForeground)]">No projectRootPath yet; open/bind a project slot first.</div>
          ) : null}
          {mcpStatus.length ? (
            <div className="mb-2 rounded border border-[var(--vscode-panel-border)] p-2">
              <div className="mb-1 text-[11px] font-semibold text-[var(--vscode-foreground)]">MCP</div>
              <div className="flex flex-wrap gap-2">
                {mcpStatus.map((s) => (
                  <span
                    key={s.name}
                    className="rounded bg-[var(--vscode-badge-background)] px-2 py-0.5 text-[10px] text-[var(--vscode-badge-foreground)]"
                    title={s.status}
                  >
                    {s.name}:{s.status}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="max-h-40 overflow-auto">
            {historySessions.length ? (
              historySessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="mb-1 flex w-full items-center justify-between gap-2 rounded px-2 py-1 hover:bg-[var(--vscode-list-hoverBackground)]"
                  title={s.sessionId}
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left text-[11px] text-[var(--vscode-foreground)]"
                    onClick={() => void loadHistorySession(s.sessionId)}
                    type="button"
                    disabled={historyLoading}
                  >
                    {new Date(s.updatedAtMs).toLocaleString()} — {s.sessionId}
                  </button>
                  <button
                    className="shrink-0 rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-0.5 text-[10px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                    onClick={() => void forkHistorySession(s.sessionId)}
                    type="button"
                    disabled={historyLoading}
                    title="Fork this session"
                  >
                    Fork
                  </button>
                </div>
              ))
            ) : (
              <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{historyLoading ? t("loading") : t("noResults")}</div>
            )}
          </div>
        </div>
      ) : null}

      {diffSessionId ? (
        <div className="border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">Diff/Review</div>
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              onClick={() => void refreshDiffFiles()}
              type="button"
            >
              Refresh
            </button>
          </div>
          {diffFiles.length ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="max-h-40 overflow-auto rounded border border-[var(--vscode-panel-border)] p-1">
                {diffFiles.map((f) => (
                  <button
                    key={f.absPath}
                    className={[
                      "block w-full truncate rounded px-2 py-1 text-left text-[11px]",
                      f.absPath === diffSelectedAbsPath ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]" : "hover:bg-[var(--vscode-list-hoverBackground)]"
                    ].join(" ")}
                    onClick={() => void loadDiffForFile(f.absPath)}
                    type="button"
                    title={f.absPath}
                  >
                    {f.absPath}
                  </button>
                ))}
              </div>
              <div className="min-h-[10rem] rounded border border-[var(--vscode-panel-border)] p-2">
                {diffState.loading ? (
                  <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loading")}</div>
                ) : diffState.error ? (
                  <div className="text-[11px] text-[var(--vscode-errorForeground)]">{diffState.error}</div>
                ) : diffSelectedAbsPath ? (
                  <div className="flex h-full flex-col">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1 truncate text-[11px] text-[var(--vscode-foreground)]" title={diffSelectedAbsPath}>
                        {diffSelectedAbsPath}
                      </div>
                      <button
                        className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                        onClick={() => {
                          const ok = window.confirm("Revert this file to Claude backup version?");
                          if (!ok) return;
                          void window.xcoding.claude.revertFileFromBackup({ absPath: diffSelectedAbsPath, content: diffState.original });
                        }}
                        type="button"
                      >
                        Revert
                      </button>
                    </div>
                    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-2 text-[10px] text-[var(--vscode-foreground)]">
                      {diffState.modified}
                    </pre>
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">Select a file</div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">No snapshot-backed file changes found yet.</div>
          )}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {messages.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
            {t("chatPlaceholder")}
          </div>
        ) : (
          messages.map((m: ClaudeUiMessage) => (
            <div key={m.id} className="mb-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{m.role}</div>
              <div className="whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2 text-sm text-[var(--vscode-foreground)]">
                {m.text}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-[var(--vscode-panel-border)] p-2">
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
            placeholder={t("ask")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <button
            className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
            onClick={() => void send()}
            type="button"
          >
            {t("send")}
          </button>
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={() => void window.xcoding.os.openExternal("https://docs.anthropic.com/claude-code")}
            type="button"
          >
            Docs
          </button>
        </div>
        <div className="mt-1 text-[10px] text-[var(--vscode-descriptionForeground)]">Ctrl/⌘+Enter to send</div>
      </div>
    </div>
  );
}
