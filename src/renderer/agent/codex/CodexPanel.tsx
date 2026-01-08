import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodexDiffView from "./CodexDiffView";
import CodexThreadView from "./CodexThreadView";
import CodexHistoryOverlay from "./components/CodexHistoryOverlay";
import CodexTopBar from "./components/CodexTopBar";
import { extractPromptRequest, renderComposerPrompt, type IdeContext } from "./prompt";
import { useCodexBridge } from "./hooks/useCodexBridge";
import Composer from "./panel/Composer";
import CodexPlanDock from "./panel/components/CodexPlanDock";
import SettingsModal from "./panel/SettingsModal";
import { createCodexStore, normalizeThread, normalizeTurn } from "./store/codexStore";
import { createCodexApprovalHandler, createCodexNotificationHandler } from "./store/codexNotifications";
import { useI18n } from "../../ui/i18n";
import { createCodexThreadsActions } from "./panel/codexThreads";
import { createCodexTurnActions } from "./panel/codexTurn";
import { createCodexConfigActions } from "./panel/codexConfig";
import { useCodexProjectScopedState } from "./panel/useCodexProjectScopedState";
import {
  AUTO_CONTEXT_KEY,
  EFFORT_KEY,
  MODEL_KEY,
  contentKey,
  getTabLabel,
  loadAutoContext,
  loadEffort,
  loadMode,
  loadModel,
  makeTurnOverrides,
  persistMode,
  type CodexMode,
  type ComposerAttachment,
  type Props,
  type ReasoningEffort,
  type Store,
  type ThreadSummary,
  type ThreadView,
  type TurnView,
  type WorkspaceWritePolicy
} from "./panel/types";

export default function CodexPanel({ slot, projectRootPath, onOpenUrl, onOpenImage }: Props) {
  const { t } = useI18n();
  const [isHistoryOpen, setIsHistoryOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDiffPanelOpen, setIsDiffPanelOpen] = useState(false);
  const [planDockOpenByThreadId, setPlanDockOpenByThreadId] = useState<Record<string, boolean>>({});
  const [planDockHeightPx, setPlanDockHeightPx] = useState(0);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [isThreadsLoading, setIsThreadsLoading] = useState(false);
  const [mode, setMode] = useState<CodexMode>(() => loadMode());
  const [model, setModel] = useState<string>(() => loadModel());
  const [effort, setEffort] = useState<ReasoningEffort>(() => loadEffort());
  const [autoContext, setAutoContext] = useState<boolean>(() => loadAutoContext());
  const [query, setQuery] = useState("");
  // Persist active thread per slot so different projects don't share the same session.
  // Do NOT include projectRootPath here; during startup it may be empty and cause key collisions.
  const activeThreadStorageKey = useMemo(() => `xcoding.codex.activeThreadId:slot:${slot}`, [slot]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const hydratedActiveThreadIdRef = useRef(false);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [threadsVersion, setThreadsVersion] = useState(0);
  const [scrollToBottomNonce, setScrollToBottomNonce] = useState(0);
  const [statusState, setStatusState] = useState<Store["status"]["state"]>("idle");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<
    Array<{
      id: string;
      model: string;
      displayName: string;
      description: string;
      supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>;
      defaultReasoningEffort: ReasoningEffort;
      isDefault: boolean;
    }>
  >([]);
  const [configSnapshot, setConfigSnapshot] = useState<{ model?: string; effort?: ReasoningEffort; workspaceWrite?: WorkspaceWritePolicy } | null>(
    null
  );

  const initialStore = useMemo(() => createCodexStore(), []);
  const storeRef = useRef<Store>(initialStore);
  const scheduledRafRef = useRef<number | null>(null);
  const ideContextRef = useRef<IdeContext | null>(null);
  const ideActiveFilePathRef = useRef<string>("");
  const attachFileInputRef = useRef<HTMLInputElement | null>(null);
  const attachImageInputRef = useRef<HTMLInputElement | null>(null);
  const hydratedSessionThreadIdsRef = useRef<Set<string>>(new Set());
  const activeThreadIdRef = useRef<string | null>(null);
  const lastReportedAiStatusRef = useRef<"idle" | "running" | null>(null);

  const activeThread = activeThreadId ? storeRef.current.threadById[activeThreadId] ?? null : null;
  activeThreadIdRef.current = activeThreadId;
  const setActiveThreadIdWithRef = (next: string | null) => {
    activeThreadIdRef.current = next;
    setActiveThreadId(next);
  };
  // Key per "project slot" first, then path as extra disambiguation.
  // In xcoding-ide, "switching project" often means switching slots; two slots can even point to the same folder.
  // If we only key by path, switching slots may incorrectly reuse the previous slot's Codex UI state.
  const projectKey = `${String(slot)}:${projectRootPath ? String(projectRootPath) : ""}`;

  const bump = useCallback(() => {
    if (scheduledRafRef.current != null) return;
    scheduledRafRef.current = window.requestAnimationFrame(() => {
      scheduledRafRef.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  const bumpThreads = useCallback(() => {
    setThreadsVersion((v) => v + 1);
  }, []);

  const handleNotification = useMemo(
    () =>
      createCodexNotificationHandler({
        storeRef,
        bump,
        bumpThreads,
        activeThreadIdRef
      }),
    [bump, bumpThreads]
  );

  const onApprovalDecision = useMemo(
    () =>
      createCodexApprovalHandler({
        storeRef,
        bump
      }),
    [bump]
  );

  useEffect(() => {
    persistMode(mode);
  }, [mode]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_KEY, model);
    } catch {
      // ignore
    }
  }, [model]);

  useEffect(() => {
    try {
      localStorage.setItem(EFFORT_KEY, effort);
    } catch {
      // ignore
    }
  }, [effort]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_CONTEXT_KEY, String(autoContext));
    } catch {
      // ignore
    }
  }, [autoContext]);

  // When the panel is remounted (or projectRootPath changes), reload persisted active thread id.
  useEffect(() => {
    hydratedActiveThreadIdRef.current = false;
    try {
      const raw = localStorage.getItem(activeThreadStorageKey);
      const persisted = raw && raw.trim() ? raw.trim() : null;
      hydratedActiveThreadIdRef.current = true;
      if (persisted) {
        activeThreadIdRef.current = persisted;
        setActiveThreadId(persisted);
      }
    } catch {
      // ignore
      hydratedActiveThreadIdRef.current = true;
    }
  }, [activeThreadStorageKey]);

  useEffect(() => {
    if (!hydratedActiveThreadIdRef.current) return;
    try {
      if (activeThreadId && activeThreadId.trim()) localStorage.setItem(activeThreadStorageKey, activeThreadId);
      else localStorage.removeItem(activeThreadStorageKey);
    } catch {
      // ignore
    }
  }, [activeThreadId, activeThreadStorageKey]);

  useCodexProjectScopedState({
    projectKey,
    isHistoryOpen,
    activeThreadId,
    query,
    isDiffPanelOpen,
    input,
    attachments,
    isPlusMenuOpen,
    isSlashMenuOpen,
    setIsHistoryOpen,
    setActiveThreadId: setActiveThreadIdWithRef,
    setQuery,
    setIsDiffPanelOpen,
    setInput,
    setAttachments,
    setIsPlusMenuOpen,
    setIsSlashMenuOpen,
    setLoadingThreadId,
    bump,
    bumpThreads
  });

  useEffect(() => {
    // After renderer refresh, subscribe first, then pull a status snapshot from main so UI
    // doesn't show "idle" when app-server is already running.
    void (async () => {
      try {
        const snap = await window.xcoding.codex.getStatus();
        if (snap.ok && snap.status) {
          storeRef.current.status = snap.status as any;
          if (typeof snap.lastStderr === "string") storeRef.current.lastStderr = snap.lastStderr;
          setStatusState((snap.status as any).state);
          bump();
        }
      } catch {
        // ignore
      }
    })();

    const onSelectionChanged = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as any;
      if (!detail || typeof detail !== "object") return;
      if (Number(detail.slot) !== slot) return;
      const filePath = typeof detail.path === "string" ? detail.path : "";
      if (!filePath) return;

      const label = getTabLabel(filePath);
      const selection = typeof detail.selection === "object" ? detail.selection : null;
      const selections = Array.isArray(detail.selections) ? detail.selections : [];
      const activeSelectionContent = typeof detail.activeSelectionContent === "string" ? detail.activeSelectionContent : "";

      const prev = ideContextRef.current ?? { activeFile: {}, openTabs: [] };
      const prevTabs = Array.isArray(prev.openTabs) ? prev.openTabs : [];
      const shouldBumpTabs = ideActiveFilePathRef.current !== filePath;

      const nextTabs = shouldBumpTabs ? [{ label, path: filePath }, ...prevTabs.filter((t) => t.path !== filePath)].slice(0, 5) : prevTabs;
      ideActiveFilePathRef.current = filePath;
      ideContextRef.current = {
        activeFile: { label, path: filePath, selection, selections, activeSelectionContent },
        openTabs: nextTabs
      };
      // Important perf note:
      // This event can fire very frequently (cursor/selection changes). We only need a re-render
      // when the active file changed (so the Auto context pill appears / recent tabs update).
      if (shouldBumpTabs) bump();
    };

    window.addEventListener("xcoding:fileSelectionChanged", onSelectionChanged as any);
    return () => window.removeEventListener("xcoding:fileSelectionChanged", onSelectionChanged as any);
  }, [slot]);

  useCodexBridge({ storeRef, bump, setStatusState, handleNotification, scheduledRafRef });

  useEffect(() => {
    if (!projectRootPath) return;
    void (async () => {
      const startRes = await window.xcoding.codex.ensureStarted();
      if (!startRes.ok) {
        storeRef.current.status = { state: "error", error: startRes.reason || "codex_start_failed" };
        setStatusState("error");
        bump();
        return;
      }
      await refreshConfigAndModels();
      await refreshThreads();
      // If we have a persisted active thread (e.g. panel was hidden/unmounted), resume it.
      const persisted = (() => {
        try {
          const raw = localStorage.getItem(activeThreadStorageKey);
          return raw && raw.trim() ? raw.trim() : null;
        } catch {
          return null;
        }
      })();
      if (persisted) {
        setIsHistoryOpen(false);
        void openThread(persisted);
      }
    })();
  }, [activeThreadStorageKey, projectRootPath]);

  // On hard refresh, status can stay `idle` for a moment while the projectRootPath is already set.
  // Auto-trigger startup so the UI doesn't look "broken" just because it's between boot steps.
  useEffect(() => {
    if (!projectRootPath) return;
    if (statusState !== "idle") return;
    void (async () => {
      const startRes = await window.xcoding.codex.ensureStarted();
      if (startRes.ok) {
        await refreshConfigAndModels();
        await refreshThreads();
      }
    })();
  }, [projectRootPath, statusState]);

  const { refreshConfigAndModels } = useMemo(() => {
    return createCodexConfigActions({
      storeRef,
      bump,
      model,
      effort,
      setModel,
      setEffort,
      setAvailableModels,
      setConfigSnapshot
    });
  }, [bump, model, effort]);

  const { refreshThreads, openThread, archiveThread } = useMemo(() => {
    const actions = createCodexThreadsActions({
      storeRef,
      bump,
      bumpThreads,
      setIsBusy,
      setIsThreadsLoading,
      setLoadingThreadId,
      setIsHistoryOpen,
      setActiveThreadId: setActiveThreadIdWithRef,
      hydratedSessionThreadIdsRef
    });
    const wrappedArchive = async (threadId: string) => {
      await actions.archiveThread(threadId);
      if (activeThreadIdRef.current === threadId) {
        setActiveThreadIdWithRef(null);
        setIsHistoryOpen(true);
        bump();
      }
    };
    return { refreshThreads: actions.refreshThreads, openThread: actions.openThread, archiveThread: wrappedArchive };
  }, [bump, bumpThreads]);

  function startNewThread() {
    if (!projectRootPath) return;
    // "New thread" should feel instant: only reset local UI state.
    // Defer `thread/start` until the first send (see sendTurn()).
    setActiveThreadIdWithRef(null);
    setLoadingThreadId(null);
    setIsDiffPanelOpen(false);
    setInput("");
    setAttachments([]);
    setIsPlusMenuOpen(false);
    setIsSlashMenuOpen(false);
    setIsHistoryOpen(true);
    bump();
  }

  const { sendTurn, stopTurn } = useMemo(
    () =>
      createCodexTurnActions({
        storeRef,
        bump,
        setIsBusy,
        setIsHistoryOpen,
        setScrollToBottomNonce,
        setInput,
        setAttachments,
        setIsPlusMenuOpen,
        setIsSlashMenuOpen,
        activeThreadIdRef,
        mode,
        model,
        effort,
        autoContext,
        configSnapshot,
        ideContextRef,
        attachments,
        projectRootPath,
        activeThread,
        setActiveThreadId: setActiveThreadIdWithRef
      }),
    [autoContext, attachments, bump, configSnapshot, effort, mode, model, projectRootPath, activeThread]
  );

  function persistCodexConfigValue(keyPath: string, value: any) {
    void window.xcoding.codex.configValueWrite({ keyPath, value, mergeStrategy: "replace" }).then((res) => {
      if (!res.ok) return;
      void refreshConfigAndModels();
    });
  }

  function onSelectModel(nextModel: string) {
    setModel(nextModel);
    const match = availableModels.find((m) => m.model === nextModel || m.id === nextModel) ?? null;
    persistCodexConfigValue("model", nextModel);
    // Keep reasoning effort independent from model selection.
    // Only adjust if the currently selected effort is not supported by the new model.
    const supported = Array.isArray(match?.supportedReasoningEfforts) ? match!.supportedReasoningEfforts.map((x: any) => x?.reasoningEffort) : [];
    const nextEffort =
      supported.length && !supported.includes(effort)
        ? (match?.defaultReasoningEffort ?? effort)
        : effort;
    if (nextEffort !== effort) setEffort(nextEffort);
    // Persist effort explicitly so refreshConfigAndModels doesn't snap back to provider defaults (e.g. Medium).
    persistCodexConfigValue("model_reasoning_effort", nextEffort);
  }

  function onSelectEffort(nextEffort: ReasoningEffort) {
    setEffort(nextEffort);
    persistCodexConfigValue("model_reasoning_effort", nextEffort);
  }

  function onSelectMode(next: CodexMode) {
    if (next === "full-access" && mode !== "full-access") {
      const ok = window.confirm(t("codexFullAccessConfirm"));
      if (!ok) return;
    }

    // 插件会在 transcript 里插入一条“Changed to {mode} mode”的系统提示。
    // 这里做一个等价的本地 synthetic item（不走 app-server），用于 1:1 观感对齐。
    if (activeThreadId && next !== mode) {
      const thread = storeRef.current.threadById[activeThreadId];
      if (thread) {
        const item = { id: `local-agent-mode-${Date.now()}`, type: "agentModeChange", mode: next };
        const turns = thread.turns ?? [];
        if (turns.length === 0) {
          thread.turns = [{ id: `local-turn-${Date.now()}`, status: "completed", items: [item] }];
        } else {
          const lastTurn = turns[turns.length - 1];
          lastTurn.items = [...(lastTurn.items ?? []), item];
        }
        bump();
      }
    }

    setMode(next);
  }

  const visibleThreads = useMemo(() => {
    const lower = query.trim().toLowerCase();
    const normalizedProjectRoot = projectRootPath ? String(projectRootPath).replace(/\\\\/g, "/").replace(/\/+$/, "") : "";
    return storeRef.current.threads
      .filter((t) => {
        if (lower && !((t.preview || "").toLowerCase().includes(lower) || t.id.toLowerCase().includes(lower))) return false;
        if (!normalizedProjectRoot) return false;
        const cwd = typeof t.cwd === "string" ? t.cwd.replace(/\\\\/g, "/") : "";
        if (!cwd) return false;
        if (!(cwd === normalizedProjectRoot || cwd.startsWith(normalizedProjectRoot + "/"))) return false;
        return true;
      })
      .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  }, [query, projectRootPath, threadsVersion]);

  const status = storeRef.current.status;
  const lastStderr = storeRef.current.lastStderr;
  const selectedModelInfo = availableModels.find((m) => m.model === model || m.id === model) ?? null;
  const supportedEfforts = selectedModelInfo?.supportedReasoningEfforts?.length
    ? selectedModelInfo.supportedReasoningEfforts
    : (["none", "minimal", "low", "medium", "high", "xhigh"] as const).map((e) => ({ reasoningEffort: e, description: "" }));
  const hasIdeContext = Boolean((ideContextRef.current as any)?.activeFile?.path);
  const hasActiveThread = Boolean(activeThreadId);

  const activeThreadTitle = activeThread?.title || "Codex";
  const isTurnInProgress = Boolean(
    activeThread?.turns?.some((t) => {
      const s = String(t.status ?? "").toLowerCase();
      return s.includes("progress") || s === "inprogress" || s === "in_progress";
    })
  );

  useEffect(() => {
    const next = isTurnInProgress ? "running" : "idle";
    if (lastReportedAiStatusRef.current === next) return;
    lastReportedAiStatusRef.current = next;
    window.dispatchEvent(new CustomEvent<XcodingSlotAiStatusDetail>("xcoding:slotAiStatus", { detail: { slot, status: next, source: "codex" } }));
  }, [isTurnInProgress, slot]);

  const latestTurnDiff = (() => {
    if (!activeThread) return null;
    const diff = typeof activeThread.latestDiff === "string" ? activeThread.latestDiff : null;
    return diff && diff.trim() ? diff : null;
  })();

  const tokenUsage = activeThreadId ? (storeRef.current.tokenUsageByThreadId?.[activeThreadId] ?? null) : null;
  const rateLimits = storeRef.current.rateLimits ?? null;

  const activePlan = (() => {
    if (!activeThread) return null;
    const normalizeStatus = (raw: unknown) => {
      const s = String(raw ?? "").toLowerCase();
      if (s === "inprogress" || s === "in_progress" || s.includes("progress")) return "in_progress";
      if (s === "completed" || s === "complete" || s === "done" || s.includes("complete")) return "completed";
      if (s === "pending") return "pending";
      return "unknown";
    };
    const isPlanCompleted = (plan: any) => {
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      if (!steps.length) return false;
      return steps.every((s: any) => normalizeStatus(s?.status) === "completed");
    };
    for (let i = activeThread.turns.length - 1; i >= 0; i--) {
      const t = activeThread.turns[i];
      const plan = (t as any)?.plan;
      if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) continue;
      if (isPlanCompleted(plan)) continue;
      return { turnId: t.id, plan };
    }
    return null;
  })();
  const isPlanDockOpen = Boolean(activeThreadId && planDockOpenByThreadId[activeThreadId]);

  const closeHistory = useCallback(() => setIsHistoryOpen(false), []);
  const toggleHistory = useCallback(() => setIsHistoryOpen((v) => !v), []);
  const toggleDiffPanel = useCallback(() => setIsDiffPanelOpen((v) => !v), []);
  const openSettings = useCallback(() => setIsSettingsOpen(true), []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <CodexTopBar
        title={activeThreadTitle || "Codex"}
        t={t}
        disableDiff={!activeThread || isBusy || isTurnInProgress}
        disableHistory={isBusy || isTurnInProgress}
        disableSettings={isBusy}
        disableNewThread={isBusy || isTurnInProgress || !projectRootPath}
        onToggleDiff={toggleDiffPanel}
        onToggleHistory={toggleHistory}
        onOpenSettings={openSettings}
        onStartNewThread={startNewThread}
      />

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <CodexThreadView
            thread={activeThread}
            approvalsByItemId={storeRef.current.approvalsByItemId}
            onApprovalDecision={onApprovalDecision}
            onOpenUrl={onOpenUrl}
            onOpenImage={onOpenImage}
            scrollToBottomNonce={scrollToBottomNonce}
            onTurnApply={(turnId) => {
              if (!activeThread) return;
              void window.xcoding.codex.turnApply({ threadId: activeThread.id, turnId }).then((res) => {
                if (!res.ok) return;
                const turn = activeThread.turns.find((t) => t.id === turnId);
                if (turn) turn.snapshot = { status: "applied" };
                bump();
              });
            }}
            onTurnRevert={(turnId) => {
              if (!activeThread) return;
              void window.xcoding.codex.turnRevert({ threadId: activeThread.id, turnId }).then((res) => {
                if (!res.ok) return;
                const turn = activeThread.turns.find((t) => t.id === turnId);
                if (turn) turn.snapshot = null;
                bump();
              });
            }}
            bottomInsetPx={activePlan ? planDockHeightPx + 12 : undefined}
          />
          {activePlan ? (
            <CodexPlanDock
              plan={activePlan.plan as any}
              isTurnInProgress={isTurnInProgress}
              isOpen={isPlanDockOpen}
              onOpenChange={(open) => {
                if (!activeThreadIdRef.current) return;
                setPlanDockOpenByThreadId((prev) => ({ ...prev, [activeThreadIdRef.current as string]: open }));
              }}
              onHeightChange={(h) => setPlanDockHeightPx(Math.max(0, Math.round(h)))}
            />
          ) : null}
        </div>

        {loadingThreadId && activeThread?.id === loadingThreadId ? (
          <div className="pointer-events-none absolute inset-x-0 top-10 z-40 flex items-center justify-center">
            <div className="mt-2 rounded-full border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] shadow">
              {t("loadingConversation")}
            </div>
          </div>
        ) : null}

        {isDiffPanelOpen ? (
          <div className="w-[420px] shrink-0 border-l border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
            <div className="flex h-9 items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2 text-[12px]">
              <div className="truncate font-semibold text-[var(--vscode-foreground)]">{t("diff")}</div>
              <button
                className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                onClick={() => setIsDiffPanelOpen(false)}
              >
                {t("close")}
              </button>
            </div>
            <div className="h-[calc(100%-2.25rem)] min-h-0">
              <CodexDiffView diff={latestTurnDiff ?? ""} />
            </div>
          </div>
        ) : null}

        <CodexHistoryOverlay
          open={isHistoryOpen}
          t={t}
          projectRootPath={projectRootPath}
          query={query}
          onChangeQuery={setQuery}
          isThreadsLoading={isThreadsLoading}
          onRefresh={refreshThreads}
          threads={visibleThreads}
          activeThreadId={activeThreadId}
          isBusy={isBusy}
          isTurnInProgress={isTurnInProgress}
          onClose={closeHistory}
          onOpenThread={openThread}
          onArchiveThread={archiveThread}
        />
      </div>

      <Composer
        projectRootPath={projectRootPath}
        statusState={status.state}
        statusError={status.error}
        lastStderr={lastStderr}
        isBusy={isBusy}
        isTurnInProgress={isTurnInProgress}
        input={input}
        onChangeInput={setInput}
        onSend={() => void sendTurn(input)}
        onStop={() => void stopTurn(activeThread)}
        onRetryStart={() => {
          void (async () => {
            const startRes = await window.xcoding.codex.ensureStarted();
            if (startRes.ok) await refreshThreads();
          })();
        }}
        onRestart={() => {
          void (async () => {
            const r = await window.xcoding.codex.restart();
            if (r.ok) {
              const startRes = await window.xcoding.codex.ensureStarted();
              if (startRes.ok) await refreshThreads();
            }
          })();
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
        attachments={attachments}
        onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
        onAddFileAttachment={async (file) => {
          const text = await file.text();
          const path = (file as any).path as string | undefined;
          const byteLength = typeof (file as any).size === "number" ? (file as any).size : undefined;
          setAttachments((prev) => [...prev, { id: `file-${Date.now()}`, kind: "file", name: file.name, path, text, byteLength }]);
        }}
        onAddImageAttachment={(file) => {
          const path = (file as any).path as string | undefined;
          if (!path) return;
          const mime = typeof (file as any).type === "string" ? (file as any).type : undefined;
          const byteLength = typeof (file as any).size === "number" ? (file as any).size : undefined;
          setAttachments((prev) => [...prev, { id: `img-${Date.now()}`, kind: "localImage", name: file.name, path, source: "picker", mime, byteLength }]);
        }}
        onAddImageAttachmentFromPath={(path, name, meta) => {
          if (!path) return;
          setAttachments((prev) => [
            ...prev,
            {
              id: `img-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              kind: "localImage",
              name,
              path,
              source: meta?.source,
              mime: meta?.mime,
              byteLength: meta?.byteLength
            }
          ]);
        }}
        attachFileInputRef={attachFileInputRef}
        attachImageInputRef={attachImageInputRef}
        isPlusMenuOpen={isPlusMenuOpen}
        setIsPlusMenuOpen={setIsPlusMenuOpen}
        isSlashMenuOpen={isSlashMenuOpen}
        setIsSlashMenuOpen={setIsSlashMenuOpen}
        onOpenUrl={onOpenUrl}
        onOpenImage={onOpenImage}
        onStartReview={(target) => {
          void (async () => {
            if (!projectRootPath) return;
            let threadId = activeThreadId;
            if (!threadId) {
              const res = await window.xcoding.codex.threadStart({ cwd: projectRootPath });
              if (!res.ok) return;
              const view = normalizeThread(res.result?.thread);
              storeRef.current.threadById[view.id] = view;
              storeRef.current.threads = [view, ...storeRef.current.threads.filter((t) => t.id !== view.id)];
              threadId = view.id;
              setActiveThreadIdWithRef(view.id);
              bump();
            }
            const r = await window.xcoding.codex.reviewStart({ threadId, target });
            if (!r.ok) return;
            const reviewThreadId = String(r.result?.reviewThreadId ?? "");
            if (reviewThreadId) await openThread(reviewThreadId);
          })();
        }}
        onRefreshModelsAndConfig={() => void refreshConfigAndModels()}
        threadId={activeThreadId}
        tokenUsage={tokenUsage}
        rateLimits={rateLimits}
        hasIdeContext={hasIdeContext}
        autoContext={autoContext}
        setAutoContext={setAutoContext}
        mode={mode}
        onSelectMode={onSelectMode}
        model={model}
        onSelectModel={onSelectModel}
        effort={effort}
        onSelectEffort={onSelectEffort}
        supportedEfforts={supportedEfforts}
        availableModels={availableModels}
      />

      <SettingsModal
        open={isSettingsOpen}
        model={model}
        effort={effort}
        configSnapshot={configSnapshot}
        onClose={() => setIsSettingsOpen(false)}
        onRefresh={() => void refreshConfigAndModels()}
      />
    </div>
  );
}
