import { Archive, FileDiff, History, Plus, RefreshCcw, Settings } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CodexDiffView from "./CodexDiffView";
import CodexThreadView from "./CodexThreadView";
import { extractPromptRequest, renderComposerPrompt, type IdeContext } from "./codexPrompt";
import Composer from "./codexPanel/Composer";
import CodexPlanDock from "./codexPanel/components/CodexPlanDock";
import SettingsModal from "./codexPanel/SettingsModal";
import { useI18n } from "./i18n";
import {
  AUTO_CONTEXT_KEY,
  EFFORT_KEY,
  MODEL_KEY,
  contentKey,
  formatThreadTime,
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
} from "./codexPanel/types";

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

  const storeRef = useRef<Store>({
    status: { state: "idle" },
    threads: [],
    threadById: {},
    approvalsByItemId: {},
    lastStderr: "",
    tokenUsageByThreadId: {},
    rateLimits: null
  });
  const projectStateRef = useRef(
    new Map<
      string,
      {
        isHistoryOpen: boolean;
        activeThreadId: string | null;
        query: string;
        isDiffPanelOpen: boolean;
        input: string;
        attachments: ComposerAttachment[];
        isPlusMenuOpen: boolean;
        isSlashMenuOpen: boolean;
      }
    >()
  );
  const scheduledRafRef = useRef<number | null>(null);
  const ideContextRef = useRef<IdeContext | null>(null);
  const ideActiveFilePathRef = useRef<string>("");
  const attachFileInputRef = useRef<HTMLInputElement | null>(null);
  const attachImageInputRef = useRef<HTMLInputElement | null>(null);
  const hydratedSessionThreadIdsRef = useRef<Set<string>>(new Set());
  const activeThreadIdRef = useRef<string | null>(null);

  const activeThread = activeThreadId ? storeRef.current.threadById[activeThreadId] ?? null : null;
  activeThreadIdRef.current = activeThreadId;
  // Key per "project slot" first, then path as extra disambiguation.
  // In xcoding-ide, "switching project" often means switching slots; two slots can even point to the same folder.
  // If we only key by path, switching slots may incorrectly reuse the previous slot's Codex UI state.
  const projectKey = `${String(slot)}:${projectRootPath ? String(projectRootPath) : ""}`;

  function bump() {
    if (scheduledRafRef.current != null) return;
    scheduledRafRef.current = window.requestAnimationFrame(() => {
      scheduledRafRef.current = null;
      setVersion((v) => v + 1);
    });
  }

  function bumpThreads() {
    setThreadsVersion((v) => v + 1);
  }

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
      if (persisted) setActiveThreadId(persisted);
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

  // Keep Codex UI state isolated per project (by projectRootPath), so switching projects
  // doesn't change another project's active thread / history query / input, and switching back restores it.
  const lastProjectKeyRef = useRef<string>(projectKey);
  useLayoutEffect(() => {
    const prevKey = lastProjectKeyRef.current;
    const nextKey = projectKey;
    if (prevKey === nextKey) return;

    // Save previous project's UI state.
    projectStateRef.current.set(prevKey, {
      isHistoryOpen,
      activeThreadId,
      query,
      isDiffPanelOpen,
      input,
      attachments,
      isPlusMenuOpen,
      isSlashMenuOpen
    });

    // Restore next project's UI state (or default).
    const restored =
      projectStateRef.current.get(nextKey) ??
      ({
        isHistoryOpen: true,
        activeThreadId: null,
        query: "",
        isDiffPanelOpen: false,
        input: "",
        attachments: [],
        isPlusMenuOpen: false,
        isSlashMenuOpen: false
      } as const);

    setIsHistoryOpen((restored as any).isHistoryOpen ?? true);
    setActiveThreadId(restored.activeThreadId);
    setQuery(restored.query);
    setIsDiffPanelOpen(restored.isDiffPanelOpen);
    setInput(restored.input);
    setAttachments(restored.attachments);
    setIsPlusMenuOpen(restored.isPlusMenuOpen);
    setIsSlashMenuOpen(restored.isSlashMenuOpen);
    setLoadingThreadId(null);
    bump();
    bumpThreads();

    lastProjectKeyRef.current = nextKey;
  }, [projectKey]);

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

  useEffect(() => {
    const offEvent = window.xcoding.codex.onEvent((event: any) => {
      if (!event || typeof event !== "object") return;
      const store = storeRef.current;

      if (event.kind === "status") {
        store.status = { state: event.status, error: typeof event.error === "string" ? event.error : undefined };
        setStatusState(store.status.state);
        bump();
        return;
      }

      if (event.kind === "stderr") {
        store.lastStderr = String(event.text ?? "");
        // stderr can be very chatty during startup; avoid repainting the whole panel
        // on every chunk once we're already ready.
        if (store.status.state !== "ready") bump();
        return;
      }

      if (event.kind !== "notification") return;
      const method = String(event.method ?? "");
      const params = event.params ?? {};
      handleNotification(method, params);
    });

    const offRequest = window.xcoding.codex.onRequest((req: any) => {
      if (!req || typeof req !== "object") return;
      if (req.kind !== "request") return;
      const method = String(req.method ?? "");
      const rpcId = Number(req.id);
      const params = req.params ?? {};

      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const itemId = String((params as any)?.itemId ?? "");
        if (!itemId) return;
        storeRef.current.approvalsByItemId[itemId] = { rpcId, method, params };
        bump();
        return;
      }

      // Unknown server-initiated request: stash it for display as a generic approval on the turn.
      const fallbackItemId = String((params as any)?.itemId ?? `rpc:${rpcId}`);
      storeRef.current.approvalsByItemId[fallbackItemId] = { rpcId, method, params };
      bump();
    });

    return () => {
      offEvent();
      offRequest();
      if (scheduledRafRef.current != null) window.cancelAnimationFrame(scheduledRafRef.current);
    };
  }, []);

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

  async function refreshConfigAndModels() {
    try {
      const [cfg, modelsRes] = await Promise.all([
        window.xcoding.codex.configRead({ includeLayers: false }),
        window.xcoding.codex.modelList({ cursor: null, limit: 200 })
      ]);

      if (cfg.ok) {
        const c = cfg.result?.config ?? {};
        const nextModel = typeof c.model === "string" ? c.model : undefined;
        const nextEffort = typeof c.model_reasoning_effort === "string" ? (c.model_reasoning_effort as ReasoningEffort) : undefined;

        const sww = c.sandbox_workspace_write;
        const workspaceWrite: WorkspaceWritePolicy = {
          writableRoots: Array.isArray(sww?.writable_roots) ? sww.writable_roots.map(String).filter(Boolean) : [],
          excludeSlashTmp: Boolean(sww?.exclude_slash_tmp),
          excludeTmpdirEnvVar: Boolean(sww?.exclude_tmpdir_env_var),
          networkAccess: Boolean(sww?.network_access)
        };

        setConfigSnapshot({ model: nextModel, effort: nextEffort, workspaceWrite });
        if (nextModel && nextModel !== model) setModel(nextModel);
        if (nextEffort && nextEffort !== effort) setEffort(nextEffort);
      }

      if (modelsRes.ok) {
        const data = Array.isArray(modelsRes.result?.data) ? (modelsRes.result.data as any[]) : [];
        const parsed = data
          .map((m) => ({
            id: String(m.id ?? ""),
            model: String(m.model ?? ""),
            displayName: String(m.displayName ?? m.display_name ?? m.model ?? ""),
            description: String(m.description ?? ""),
            supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts)
              ? m.supportedReasoningEfforts
                  .map((o: any) => ({
                    reasoningEffort: String(o.reasoningEffort ?? o.reasoning_effort ?? "") as ReasoningEffort,
                    description: String(o.description ?? "")
                  }))
                  .filter((o: any) => o.reasoningEffort)
              : [],
            defaultReasoningEffort: String(m.defaultReasoningEffort ?? m.default_reasoning_effort ?? "medium") as ReasoningEffort,
            isDefault: Boolean(m.isDefault ?? m.is_default)
          }))
          .filter((m) => m.model || m.id);

        setAvailableModels(parsed);

        const resolvedModel =
          (cfg.ok && typeof cfg.result?.config?.model === "string" ? (cfg.result.config.model as string) : "") ||
          (parsed.find((m) => m.isDefault)?.model ?? "") ||
          (parsed[0]?.model ?? "");
        if (resolvedModel && resolvedModel !== model) setModel(resolvedModel);
        const resolvedEffort =
          (cfg.ok && typeof cfg.result?.config?.modelReasoningEffort === "string"
            ? (cfg.result.config.modelReasoningEffort as ReasoningEffort)
            : undefined) ||
          (parsed.find((m) => m.model === resolvedModel)?.defaultReasoningEffort ?? "medium");
        if (resolvedEffort && resolvedEffort !== effort) setEffort(resolvedEffort);
      }
    } catch {
      // ignore
    }
  }

  async function refreshThreads() {
    setIsThreadsLoading(true);
    try {
      const res = await window.xcoding.codex.threadList({ cursor: null, limit: 100 });
      if (!res.ok) throw new Error(res.reason || "thread_list_failed");
      const data = Array.isArray(res.result?.data) ? (res.result.data as any[]) : [];
      const threads: ThreadSummary[] = data
        .map((t) => ({
          id: String(t.id ?? ""),
          preview: String(t.preview ?? ""),
          previewText: extractPromptRequest(String(t.preview ?? "")),
          title: extractPromptRequest(String(t.preview ?? "")) || String(t.preview ?? ""),
          modelProvider: typeof t.modelProvider === "string" ? t.modelProvider : undefined,
          createdAt: typeof t.createdAt === "number" ? t.createdAt : undefined,
          path: typeof t.path === "string" ? t.path : undefined,
          cwd: typeof t.cwd === "string" ? t.cwd : undefined
        }))
        .filter((t) => t.id);
      storeRef.current.threads = threads;
      bumpThreads();
      bump();
    } finally {
      setIsThreadsLoading(false);
    }
  }

  async function archiveThread(threadId: string) {
    setIsBusy(true);
    try {
      const res = await window.xcoding.codex.threadArchive({ threadId });
      if (!res.ok) throw new Error(res.reason || "thread_archive_failed");
      storeRef.current.threads = storeRef.current.threads.filter((t) => t.id !== threadId);
      delete storeRef.current.threadById[threadId];
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setIsHistoryOpen(true);
      }
      bumpThreads();
      bump();
    } finally {
      setIsBusy(false);
    }
  }

  function startNewThread() {
    if (!projectRootPath) return;
    // "New thread" should feel instant: only reset local UI state.
    // Defer `thread/start` until the first send (see sendTurn()).
    setActiveThreadId(null);
    setLoadingThreadId(null);
    setIsDiffPanelOpen(false);
    setInput("");
    setAttachments([]);
    setIsPlusMenuOpen(false);
    setIsSlashMenuOpen(false);
    setIsHistoryOpen(true);
    bump();
  }

  async function openThread(threadId: string) {
    const hydrateFromSession = async (t: ThreadView) => {
      const sessionPath = typeof (t as any)?.path === "string" ? String((t as any).path) : "";
      if (!sessionPath) return;
      if (hydratedSessionThreadIdsRef.current.has(t.id)) return;
      hydratedSessionThreadIdsRef.current.add(t.id);
      try {
        const res = await window.xcoding.codex.sessionRead({ path: sessionPath });
        if (!res.ok) return;
        const sessionTurns = Array.isArray(res.result?.turns) ? (res.result?.turns as any[]) : [];
        if (!sessionTurns.length) return;
        const thread = storeRef.current.threadById[t.id];
        if (!thread) return;

        for (const st of sessionTurns) {
          const stId = String(st?.id ?? "");
          if (!stId) continue;
          const target = thread.turns.find((x) => x.id === stId) ?? null;
          if (!target) continue;

          const existingItems = Array.isArray(target.items) ? target.items : [];
          const hasAnyTools = existingItems.some((it: any) => {
            const ty = String(it?.type ?? "");
            return ty === "commandExecution" || ty === "fileChange" || ty === "mcpToolCall" || ty === "localToolCall";
          });
          if (hasAnyTools) continue;

          const sessionItems = Array.isArray(st?.items) ? st.items : [];
          const toolItems = sessionItems.filter((it: any) => {
            const ty = String(it?.type ?? "");
            if (ty === "userMessage" || ty === "agentMessage") return false;
            if (ty === "reasoning") return existingItems.some((x: any) => String(x?.type ?? "") === "reasoning") ? false : true;
            return true;
          });
          if (!toolItems.length) continue;

          const insertAt = (() => {
            const idx = existingItems.findIndex((it: any) => String(it?.type ?? "") === "agentMessage");
            return idx >= 0 ? idx : existingItems.length;
          })();

          target.items = [...existingItems.slice(0, insertAt), ...toolItems, ...existingItems.slice(insertAt)];
        }
        bump();
      } catch {
        // ignore
      }
    };

    // If we already have the thread fully in memory, switch instantly.
    const cached = storeRef.current.threadById[threadId];
    if (cached?.turns?.length) {
      setActiveThreadId(threadId);
      setIsHistoryOpen(false);
      bump();
      void hydrateFromSession(cached);
      return;
    }

    setActiveThreadId(threadId);
    setIsHistoryOpen(false);
    setLoadingThreadId(threadId);

    // Show something immediately while the heavy resume payload arrives.
    if (!cached) {
      const summary = storeRef.current.threads.find((t) => t.id === threadId);
      storeRef.current.threadById[threadId] = {
        id: threadId,
        preview: summary?.preview ?? "",
        title: summary?.title ?? (summary?.previewText ?? summary?.preview ?? ""),
        modelProvider: summary?.modelProvider,
        createdAt: summary?.createdAt,
        path: summary?.path,
        cwd: summary?.cwd,
        turns: []
      };
    }
    bump();

    setIsBusy(true);
    try {
      const res = await window.xcoding.codex.threadResume({ threadId });
      if (!res.ok) throw new Error(res.reason || "thread_resume_failed");
      const thread = res.result?.thread;
      if (!thread?.id) throw new Error("thread_missing");
      const view = normalizeThread(thread);
      storeRef.current.threadById[view.id] = view;
      setActiveThreadId(view.id);
      setIsHistoryOpen(false);
      bump();
      void hydrateFromSession(view);
    } finally {
      setIsBusy(false);
      setLoadingThreadId((v) => (v === threadId ? null : v));
    }
  }

  async function sendTurn() {
    const requestMessage = input.trim();
    if (!requestMessage) return;
    if (!projectRootPath) return;
    if (
      activeThread?.turns?.some((t) => {
        const s = String(t.status ?? "").toLowerCase();
        return s.includes("progress") || s === "inprogress" || s === "in_progress";
      })
    ) {
      return;
    }

    setIsHistoryOpen(false);
    setIsBusy(true);
    try {
      let threadId = activeThreadId;
      if (!threadId) {
        const res = await window.xcoding.codex.threadStart({ cwd: projectRootPath });
        if (!res.ok) throw new Error(res.reason || "thread_start_failed");
        const thread = res.result?.thread;
        if (!thread?.id) throw new Error("thread_missing");
        const view = normalizeThread(thread);
        storeRef.current.threadById[view.id] = view;
        storeRef.current.threads = [view, ...storeRef.current.threads.filter((t) => t.id !== view.id)];
        threadId = view.id;
        setActiveThreadId(view.id);
      }

      const effectiveCwd = activeThread?.cwd || projectRootPath;
      const overrides = makeTurnOverrides(mode, effectiveCwd, configSnapshot?.workspaceWrite ?? null);
      const composedText =
        autoContext && ideContextRef.current
          ? renderComposerPrompt({ requestMessage, ideContext: ideContextRef.current })
          : requestMessage;
      const inputBlocks = [
        { type: "text", text: composedText },
        ...attachments.map((a) => {
          if (a.kind === "localImage") return { type: "localImage", path: a.path };
          const header = a.path ? `# Attached file: ${a.path}` : `# Attached file: ${a.name}`;
          const body = a.text.length > 200_000 ? `${a.text.slice(0, 200_000)}\n\n…(truncated)…` : a.text;
          return { type: "text", text: `${header}\n\n\`\`\`\n${body}\n\`\`\`` };
        })
      ];
      const res = await window.xcoding.codex.turnStart({
        threadId,
        input: inputBlocks,
        cwd: effectiveCwd,
        approvalPolicy: overrides.approvalPolicy,
        sandboxPolicy: overrides.sandboxPolicy,
        model: model || undefined,
        effort: effort || undefined
      });
      if (!res.ok) throw new Error(res.reason || "turn_start_failed");

      // Some Codex builds/hosts may not emit `turn/started` notifications reliably.
      // Fall back to the response payload so the UI always renders the user message immediately.
      const store = storeRef.current;
      const thread = store.threadById[threadId];
      if (thread) {
        const rawTurn = (res.result as any)?.turn;
        const rawTurnId = String((res.result as any)?.turnId ?? "");
        const turnFromResponse = rawTurn?.id ? normalizeTurn(rawTurn) : rawTurnId ? ({ id: rawTurnId, status: "inProgress", items: [] } satisfies TurnView) : null;
        if (turnFromResponse && !thread.turns.some((t) => t.id === turnFromResponse.id)) {
          thread.turns = [...(thread.turns ?? []), turnFromResponse];
        }
        const turnId = turnFromResponse?.id || rawTurnId;
        if (turnId) {
          const turnView = thread.turns.find((t) => t.id === turnId);
          if (turnView) {
            // Optimistic user item so the transcript is never empty.
            const hasUserItem =
              Array.isArray(turnView.items) &&
              turnView.items.some((it: any) => String((it as any)?.type ?? "") === "userMessage" || String((it as any)?.role ?? "") === "user");
            if (!hasUserItem) {
              const content = inputBlocks;
              turnView.items = [
                ...(turnView.items ?? []),
                {
                  id: `local-user-${Date.now()}`,
                  type: "userMessage",
                  content,
                  __optimistic: true,
                  __contentKey: contentKey(content)
                }
              ];
            }
          }
        }
        bump();
      }
      setInput("");
      setAttachments([]);
      setIsPlusMenuOpen(false);
      setIsSlashMenuOpen(false);
    } finally {
      setIsBusy(false);
    }
  }

  async function stopTurn() {
    if (!activeThread) return;
    const last = [...(activeThread.turns ?? [])]
      .reverse()
      .find((t) => {
        const s = String(t.status ?? "").toLowerCase();
        return s.includes("progress") || s === "inprogress" || s === "in_progress";
      });
    if (!last) return;
    await window.xcoding.codex.turnInterrupt({ threadId: activeThread.id, turnId: last.id });
  }

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

  function onApprovalDecision(itemId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
    const req = storeRef.current.approvalsByItemId[itemId];
    if (!req) return;
    delete storeRef.current.approvalsByItemId[itemId];
    if ((decision === "accept" || decision === "acceptForSession") && req.method === "item/fileChange/requestApproval") {
      const threadId = String(req.params?.threadId ?? "");
      const turnId = String(req.params?.turnId ?? "");
      const thread = threadId ? storeRef.current.threadById[threadId] : null;
      const turn = thread && turnId ? thread.turns.find((t) => t.id === turnId) : null;
      if (turn) {
        turn.snapshot = { status: "available" };
      }
    }
    bump();
    void window.xcoding.codex.respond({ id: req.rpcId, result: { decision } });
  }

  function handleNotification(method: string, params: any) {
    const store = storeRef.current;
    // IMPORTANT: never "guess" threadId (e.g. falling back to activeThreadId) when multiple Codex panels are mounted.
    // Cross-panel guessing causes events from other projects/slots to leak into this panel.
    const resolveThreadId = (raw: unknown) => {
      const threadId = String(raw ?? "");
      return threadId && threadId.trim() ? threadId.trim() : "";
    };
    const ensureThread = (threadId: string) =>
      store.threadById[threadId] ??
      (store.threadById[threadId] = { id: threadId, preview: "", title: "", turns: [], createdAt: undefined, cwd: undefined });
    const ensureTurn = (threadId: string, turnId: string) => {
      const thread = ensureThread(threadId);
      let turn = thread.turns.find((t) => t.id === turnId);
      if (!turn) {
        turn = { id: turnId, status: "inProgress", items: [] };
        thread.turns = [...(thread.turns ?? []), turn];
      }
      return turn;
    };

    const commitTurn = (threadId: string, turnId: string, nextTurn: any) => {
      const thread = ensureThread(threadId);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const idx = turns.findIndex((t) => String(t?.id ?? "") === turnId);
      const cloned = { ...(nextTurn ?? {}), id: turnId, items: Array.isArray(nextTurn?.items) ? [...nextTurn.items] : [] };
      thread.turns = idx >= 0 ? [...turns.slice(0, idx), cloned, ...turns.slice(idx + 1)] : [...turns, cloned];
    };

    const upsertItem = (threadId: string, turnId: string, item: any) => {
      const turn = ensureTurn(threadId, turnId);
      const itemId = String(item?.id ?? "");
      if (!itemId) return;
      const items = Array.isArray(turn.items) ? turn.items : [];
      const idx = items.findIndex((it) => String(it?.id ?? "") === itemId);
      const nextItems = idx >= 0 ? [...items.slice(0, idx), item, ...items.slice(idx + 1)] : [...items, item];
      const nextTurn = { ...turn, items: nextItems };
      commitTurn(threadId, turnId, nextTurn);
    };

    const pickActiveTurnId = (threadId: string) => {
      const thread = ensureThread(threadId);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const running = [...turns].reverse().find((t) => {
        const s = String(t?.status ?? "").toLowerCase();
        return s.includes("progress") || s === "inprogress" || s === "in_progress";
      });
      if (running?.id) return String(running.id);
      const last = turns.length ? turns[turns.length - 1] : null;
      if (last?.id) return String(last.id);
      const synthetic = `local-turn-${Date.now()}`;
      ensureTurn(threadId, synthetic);
      return synthetic;
    };

    const normalizeToolItemType = (item: any) => {
      const name = String(item?.name ?? "");
      if (name === "shell_command") {
        item.type = "commandExecution";
        try {
          const args = JSON.parse(String(item.arguments ?? "{}"));
          if (args && typeof args === "object" && typeof args.command === "string") item.command = args.command;
        } catch {
          // ignore
        }
        if (typeof item.output === "string") item.aggregatedOutput = item.output;
      } else if (name === "apply_patch") {
        item.type = "fileChange";
        const patchText = String(item.input ?? "");
        if (patchText) {
          const paths: string[] = [];
          for (const line of patchText.split(/\r?\n/)) {
            const m = line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
            if (m && m[2]) paths.push(m[2]);
          }
          item.changes = paths.length ? paths.map((p) => ({ path: p, kind: "patch", diff: patchText })) : [{ path: "patch", kind: "patch", diff: patchText }];
        }
      }
    };

    const upsertToolByCallId = (threadId: string, turnId: string, callId: string, patch: (it: any) => void) => {
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === callId);
      if (!item) {
        item = { type: "localToolCall", id: callId, name: "", arguments: "", input: "", output: "", status: "inProgress" };
      }
      patch(item);
      normalizeToolItemType(item);
      // Commit via immutable update so the thread view memo re-computes.
      upsertItem(threadId, turnId, item);
    };

    // NOTE: We intentionally ignore `codex/event/*` JSONL notifications here.
    // They carry a `conversationId` but not a stable `threadId` for routing, which causes cross-slot leakage
    // when multiple Codex panels are mounted. We rely on `turn/*` and `item/*` events which include `threadId`.
    if (method.startsWith("codex/event/")) return;

    if (method === "thread/started") {
      const thread = params?.thread;
      const view = normalizeThread(thread);
      store.threads = [view, ...store.threads.filter((t) => t.id !== view.id)];
      store.threadById[view.id] = store.threadById[view.id] ?? view;
      bumpThreads();
      bump();
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const threadId = resolveThreadId(params?.threadId ?? params?.thread_id ?? "");
      if (!threadId) return;
      // Only track usage for threads we know about in this panel.
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      store.tokenUsageByThreadId[threadId] = params?.tokenUsage ?? params?.token_usage ?? null;
      bump();
      return;
    }

    if (method === "account/rateLimits/updated") {
      store.rateLimits = params?.rateLimits ?? params?.rate_limits ?? null;
      bump();
      return;
    }

    if (method === "turn/started") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turn = params?.turn;
      if (!threadId || !turn?.id) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const existing = ensureThread(threadId);
      const turnView = normalizeTurn(turn);
      const idx = existing.turns.findIndex((t) => t.id === turnView.id);
      if (idx >= 0) {
        const prev = existing.turns[idx];
        turnView.items = prev.items?.length ? prev.items : turnView.items;
        turnView.plan = prev.plan ?? turnView.plan;
        turnView.diff = prev.diff ?? turnView.diff;
        existing.turns = [...existing.turns.slice(0, idx), turnView, ...existing.turns.slice(idx + 1)];
      } else {
        existing.turns = [...(existing.turns ?? []), turnView];
      }
      bump();
      return;
    }

    if (method === "turn/completed") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turn = params?.turn;
      if (!threadId || !turn?.id) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const existing = store.threadById[threadId];
      if (!existing) return;
      const idx = existing.turns.findIndex((t) => t.id === String(turn.id));
      const updated = normalizeTurn(turn);
      if (idx >= 0) {
        const prev = existing.turns[idx];
        updated.items = prev.items?.length ? prev.items : updated.items;
        updated.plan = prev.plan ?? updated.plan;
        updated.diff = prev.diff ?? updated.diff;
        existing.turns = [...existing.turns.slice(0, idx), updated, ...existing.turns.slice(idx + 1)];
      } else {
        existing.turns = [...(existing.turns ?? []), updated];
      }
      bump();
      return;
    }

    if (method === "item/started" || method === "item/completed" || method === "item/updated" || method === "item/added") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const item = params?.item;
      if (!threadId || !turnId || !item?.id) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const itemId = String(item.id);

      if (String(item?.type ?? "") === "userMessage") {
        const thread = storeRef.current.threadById[threadId];
        if (thread && !thread.title) {
          try {
            const blocks = Array.isArray((item as any)?.content) ? (item as any).content : [];
            const text = extractPromptRequest(
              blocks
                .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
                .filter(Boolean)
                .join("\n")
            );
            if (text) thread.title = text;
          } catch {
            // ignore
          }
        }
        // 一旦收到真实 userMessage，就清理掉所有 optimistic userMessage（避免因序列化差异导致去重失败）。
        turn.items = (turn.items ?? []).filter((it) => {
          if (!it || typeof it !== "object") return true;
          if (String((it as any).type ?? "") !== "userMessage") return true;
          return !(it as any).__optimistic;
        });
      }

      upsertItem(threadId, turnId, item);
      bump();
      return;
    }

    // Some Codex hosts emit generic item payload notifications (not strictly started/completed).
    // Treat them as an upsert so UI can render tools progressively.
    if (method.startsWith("item/") && params?.item?.id && typeof params?.threadId === "string" && typeof params?.turnId === "string") {
      const threadId = resolveThreadId(params.threadId);
      if (!threadId) return;
      if (threadId !== activeThreadIdRef.current) return;
      upsertItem(threadId, String(params.turnId), params.item);
      bump();
      return;
    }

    if (method === "item/agentMessage/delta") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? "");
      const delta = String(params?.delta ?? "");
      if (!threadId || !turnId || !itemId || !delta) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) {
        item = { id: itemId, type: "agentMessage", status: "inProgress", text: "" };
      }
      if (!item.status) item.status = "inProgress";
      item.text = String(item.text ?? "") + delta;
      upsertItem(threadId, turnId, item);
      bump();
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? "");
      const delta = String(params?.delta ?? "");
      if (!threadId || !turnId || !itemId || !delta) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) {
        item = { id: itemId, type: "commandExecution", status: "inProgress", aggregatedOutput: "" };
      }
      if (!item.status) item.status = "inProgress";
      item.aggregatedOutput = String(item.aggregatedOutput ?? "") + delta;
      upsertItem(threadId, turnId, item);
      bump();
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? "");
      const delta = String(params?.delta ?? "");
      const summaryIndex = Number(params?.summaryIndex ?? 0);
      if (!threadId || !turnId || !itemId || !delta) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const item = turn.items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) return;
      const idx = Number.isFinite(summaryIndex) && summaryIndex >= 0 ? summaryIndex : 0;
      const summary = Array.isArray((item as any).summary) ? (item as any).summary : [];
      while (summary.length <= idx) summary.push("");
      summary[idx] = String(summary[idx] ?? "") + delta;
      (item as any).summary = summary;
      bump();
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? "");
      const summaryIndex = Number(params?.summaryIndex ?? 0);
      if (!threadId || !turnId || !itemId) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const item = turn.items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) return;
      const idx = Number.isFinite(summaryIndex) && summaryIndex >= 0 ? summaryIndex : 0;
      const summary = Array.isArray((item as any).summary) ? (item as any).summary : [];
      while (summary.length <= idx) summary.push("");
      (item as any).summary = summary;
      bump();
      return;
    }

    if (method === "item/reasoning/textDelta") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? "");
      const delta = String(params?.delta ?? "");
      const contentIndex = Number(params?.contentIndex ?? 0);
      if (!threadId || !turnId || !itemId || !delta) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) {
        item = { id: itemId, type: "reasoning", status: "inProgress", content: [] as string[] };
      }
      if (!item.status) item.status = "inProgress";
      const idx = Number.isFinite(contentIndex) && contentIndex >= 0 ? contentIndex : 0;
      const content = Array.isArray((item as any).content) ? (item as any).content : [];
      while (content.length <= idx) content.push("");
      content[idx] = String(content[idx] ?? "") + delta;
      (item as any).content = content;
      upsertItem(threadId, turnId, item);
      bump();
      return;
    }

    // Fallback: handle unknown delta-style streaming updates (tool outputs vary by host).
    if (method.includes("delta") && typeof params === "object" && params) {
      const threadId = String(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? params?.id ?? "");
      const deltaRaw =
        typeof params?.delta === "string"
          ? params.delta
          : typeof params?.text === "string"
            ? params.text
            : typeof params?.chunk === "string"
              ? params.chunk
              : typeof params?.output === "string"
                ? params.output
                : "";
      const delta = String(deltaRaw ?? "");
      if (!threadId || !turnId || !itemId || !delta) return;
      const turn = ensureTurn(threadId, turnId);
      let item = turn.items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) {
        // Heuristic: route to agentMessage vs commandExecution.
        const typeGuess =
          method.includes("command") || method.includes("exec") || method.includes("tool") || method.includes("output") ? "commandExecution" : "agentMessage";
        item = { id: itemId, type: typeGuess, status: "inProgress" };
        turn.items.push(item);
      }
      if (!item.status) item.status = "inProgress";
      if (String(item?.type ?? "") === "commandExecution") item.aggregatedOutput = String(item.aggregatedOutput ?? "") + delta;
      else if (String(item?.type ?? "") === "reasoning") {
        const content = Array.isArray((item as any).content) ? (item as any).content : [];
        if (!content.length) content.push("");
        content[0] = String(content[0] ?? "") + delta;
        (item as any).content = content;
      } else item.text = String(item.text ?? "") + delta;
      bump();
      return;
    }

    if (method === "turn/plan/updated") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      if (!threadId || !turnId) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const plan = Array.isArray(params?.plan) ? params.plan : [];
      const wasEmpty = !turn.plan || !Array.isArray(turn.plan.steps) || turn.plan.steps.length === 0;
      turn.plan = { explanation: params?.explanation ?? null, steps: plan };
      if (wasEmpty && plan.length) {
        setPlanDockOpenByThreadId((prev) => ({ ...prev, [threadId]: true }));
      }
      bump();
      return;
    }

    if (method === "turn/diff/updated") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      if (!threadId || !turnId) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      turn.diff = typeof params?.diff === "string" ? params.diff : null;
      const thread = storeRef.current.threadById[threadId];
      if (thread) thread.latestDiff = turn.diff;
      bump();
      return;
    }

    if (method === "error") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      if (!threadId || !turnId) return;
      if (threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      turn.error = params?.error ?? { message: "error" };
      bump();
    }
  }

  function normalizeTurn(turn: any): TurnView {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return {
      id: String(turn?.id ?? ""),
      status: typeof turn?.status === "string" ? turn.status : undefined,
      items,
      error: turn?.error
    };
  }

  function normalizeThread(thread: any): ThreadView {
    const turnsRaw = Array.isArray(thread?.turns) ? thread.turns : [];
    const turns = turnsRaw.map((t: any) => normalizeTurn(t)).filter((t: TurnView) => t.id);
    const preview = String(thread?.preview ?? "");
    const title = extractPromptRequest(preview) || preview;
    const latestDiff = (() => {
      for (let i = turns.length - 1; i >= 0; i--) {
        const diff = turns[i]?.diff;
        if (typeof diff === "string" && diff.trim()) return diff;
      }
      return null;
    })();
    return {
      id: String(thread?.id ?? ""),
      preview,
      title,
      modelProvider: typeof thread?.modelProvider === "string" ? thread.modelProvider : undefined,
      createdAt: typeof thread?.createdAt === "number" ? thread.createdAt : undefined,
      path: typeof thread?.path === "string" ? thread.path : undefined,
      cwd: typeof thread?.cwd === "string" ? thread.cwd : undefined,
      turns,
      latestDiff
    };
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

  const latestTurnDiff = (() => {
    if (!activeThread) return null;
    const diff = typeof activeThread.latestDiff === "string" ? activeThread.latestDiff : null;
    return diff && diff.trim() ? diff : null;
  })();

  const tokenUsage = activeThreadId ? (storeRef.current.tokenUsageByThreadId?.[activeThreadId] ?? null) : null;
  const rateLimits = storeRef.current.rateLimits ?? null;

  const activePlan = (() => {
    if (!activeThread) return null;
    for (let i = activeThread.turns.length - 1; i >= 0; i--) {
      const t = activeThread.turns[i];
      const plan = (t as any)?.plan;
      if (plan && Array.isArray(plan.steps) && plan.steps.length) return { turnId: t.id, plan };
    }
    return null;
  })();
  const isPlanDockOpen = Boolean(activeThreadId && planDockOpenByThreadId[activeThreadId]);

  const showHistoryOverlay = isHistoryOpen;

  useEffect(() => {
    if (!showHistoryOverlay) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsHistoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showHistoryOverlay]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2">
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 truncate text-[12px] font-semibold text-[var(--vscode-foreground)]">
            {activeThreadTitle || "Codex"}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => setIsDiffPanelOpen((v) => !v)}
            type="button"
            title={t("toggleDiffPanel")}
            disabled={!activeThread || isBusy || isTurnInProgress}
          >
            <FileDiff className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => {
              setIsHistoryOpen((v) => !v);
            }}
            type="button"
            title={t("history")}
            disabled={isBusy || isTurnInProgress}
          >
            <History className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => setIsSettingsOpen(true)}
            type="button"
            title={t("settings")}
            disabled={isBusy}
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => startNewThread()}
            type="button"
            title={t("newThread")}
            disabled={isBusy || isTurnInProgress || !projectRootPath}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <CodexThreadView
            thread={activeThread}
            approvalsByItemId={storeRef.current.approvalsByItemId}
            onApprovalDecision={onApprovalDecision}
            onOpenUrl={onOpenUrl}
            onOpenImage={onOpenImage}
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

        {showHistoryOverlay ? (
          <>
	            <button
	              type="button"
	              aria-label={t("closeHistory")}
	              className="absolute inset-0 z-40 bg-black/40"
	              onClick={() => setIsHistoryOpen(false)}
	            />
	            <div className="absolute left-3 right-3 top-3 z-50 flex h-[35%] min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] shadow-2xl">
	              <div className="border-b border-[var(--vscode-panel-border)] p-2">
	                <div className="flex items-center gap-2">
	                  <input
	                    className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
	                    placeholder={t("searchRecentTasks")}
	                    value={query}
	                    onChange={(e) => setQuery(e.target.value)}
	                  />
	                  <button
	                    className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
	                    onClick={() => void refreshThreads()}
	                    type="button"
                    title={t("refresh")}
                    disabled={isThreadsLoading}
                  >
                    <RefreshCcw className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-1">
                {isThreadsLoading ? (
                  <div className="mb-2 rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
                    Loading…
                  </div>
                ) : null}
                {visibleThreads.length === 0 ? (
                  <div className="rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
                    {projectRootPath ? "No conversations yet." : "Bind a project folder to use Codex."}
                  </div>
                ) : null}
	                {visibleThreads.map((t) => {
	                  const isActive = t.id === activeThreadId;
	                  const preview = t.previewText ?? (t.preview ? extractPromptRequest(t.preview) : "");
	                  return (
	                    <div
	                      key={t.id}
	                      className={[
	                        "group relative w-full rounded px-2 py-2 text-left",
	                        isActive
	                          ? "bg-[var(--vscode-list-activeSelectionBackground)]"
	                          : isTurnInProgress
	                            ? "opacity-50"
	                            : "hover:bg-[var(--vscode-list-hoverBackground)]"
	                      ].join(" ")}
	                      title={preview || t.preview || t.id}
	                    >
	                      <button
	                        className="block w-full text-left"
	                        type="button"
	                        disabled={isBusy || isTurnInProgress}
	                        onClick={() => {
	                          setIsHistoryOpen(false);
	                          void openThread(t.id);
	                        }}
	                      >
                      <div
                        className={[
                          "truncate text-[12px]",
                          isActive ? "text-[var(--vscode-list-activeSelectionForeground)]" : "text-[var(--vscode-foreground)]"
                        ].join(" ")}
                      >
                        {preview || t.preview || "(no preview)"}
                      </div>
                      <div
                        className={[
                          "flex items-center justify-between gap-2 text-[10px]",
                          isActive ? "text-white/70" : "text-[var(--vscode-descriptionForeground)]"
                        ].join(" ")}
                      >
                        <div className="min-w-0 truncate" title={t.cwd || ""}>
                          {t.cwd || ""}
                        </div>
                        <div className="shrink-0">{formatThreadTime(t.createdAt)}</div>
                      </div>
	                      </button>

	                      <button
	                        className="invisible absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible disabled:opacity-50"
	                        type="button"
	                        title="Archive"
	                        disabled={isBusy || isTurnInProgress}
	                        onClick={(e) => {
	                          e.stopPropagation();
	                          void archiveThread(t.id);
	                        }}
	                      >
	                        <Archive className="h-4 w-4" />
	                      </button>
	                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}
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
        onSend={() => void sendTurn()}
        onStop={() => void stopTurn()}
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
              setActiveThreadId(view.id);
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
