import { Copy, ExternalLink, FileDiff, History as HistoryIcon, Plus, Settings, Slash, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { useI18n } from "../../ui/i18n";
import { applyClaudeStreamEvent, createClaudeStore, type ClaudeEventEnvelope, type ClaudeStore, type ClaudeUiMessage } from "./store/claudeStore";
import { persistMode, safeLoadMode, type ClaudePermissionMode } from "./panel/types";
import ClaudeHistoryOverlay from "./components/ClaudeHistoryOverlay";
import ClaudeSettingsModal from "./panel/ClaudeSettingsModal";
import ClaudeAuthModal from "./panel/ClaudeAuthModal";
import ClaudeFileDiffView from "./components/ClaudeFileDiffView";
import DiffViewer from "../shared/DiffViewer";
import ProposedDiffCard, { type ProposedDiffCardPreview } from "../shared/ProposedDiffCard";
import { ClaudeCommandRegistry, type ClaudeRegisteredCommand } from "./commandRegistry";
import {
  canonicalizeAtMentionBody,
  extractAtMentionPathsFromText,
  formatAtMentionBody,
  formatAtMentionToken,
  parseAtMentionBody
} from "./panel/atMentions";
import { findAtToken, findSlashToken } from "./panel/inputTokens";
import {
  coerceNonEmptyString,
  formatJson,
  modeLabel,
  OFFICIAL_DENY_MESSAGE,
  OFFICIAL_STAY_IN_PLAN_MESSAGE,
  parseToolMessage,
  toProposedDiffCardPreview
} from "./panel/panelUtils";
import { useClaudeDiffPanel } from "./panel/useClaudeDiffPanel";
import { useClaudeHistory } from "./panel/useClaudeHistory";
import { useClaudeMarkdownComponents } from "./panel/useClaudeMarkdownComponents";

type Props = {
  slot: number;
  projectRootPath?: string;
  onOpenUrl: (url: string) => void;
  onOpenFile: (relPath: string, line?: number, column?: number) => void;
  onOpenTerminalAndRun?: (command: string, options?: { title?: string }) => void;
  isActive?: boolean;
};

export default function ClaudePanel({ slot, projectRootPath, onOpenUrl, onOpenFile, onOpenTerminalAndRun, isActive }: Props) {
  const { t } = useI18n();
  const isDev = Boolean((import.meta as any)?.env?.DEV);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<ClaudePermissionMode>("default");
  const [input, setInput] = useState("");
  const [isTurnInProgress, setIsTurnInProgress] = useState(false);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const interruptedDraftBySessionIdRef = useRef<Map<string, ClaudeUiMessage[]>>(new Map());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const storeRef = useRef<ClaudeStore>(createClaudeStore());
  const scheduledRafRef = useRef<number | null>(null);
  const hydratedModeRef = useRef(false);
  const lastClaudeStreamAtRef = useRef<number>(0);
  const pendingStreamEventsRef = useRef<any[]>([]);
  const streamFlushTimerRef = useRef<number | null>(null);
  const [openById, setOpenById] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [commandMenuMode, setCommandMenuMode] = useState<null | { kind: "button" } | { kind: "slashToken"; start: number; end: number }>(null);
  const [commandMenuActiveId, setCommandMenuActiveId] = useState<string | null>(null);
  const [commandMenuScrollToId, setCommandMenuScrollToId] = useState<string | null>(null);
  const [supportedCommands, setSupportedCommands] = useState<Array<{ name: string; description: string; argumentHint: string }>>([]);
  const [supportedModels, setSupportedModels] = useState<Array<{ value: string; displayName: string; description: string }>>([]);
  const [accountInfo, setAccountInfo] = useState<{ email?: string; organization?: string; subscriptionType?: string; tokenSource?: string } | null>(
    null
  );
  const [currentModel, setCurrentModel] = useState<string>("default");
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(true);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [activeEditorContext, setActiveEditorContext] = useState<null | { relPath: string; label: string; range: null | { startLine: number; endLine: number } }>(
    null
  );
  const activeEditorContextKeyRef = useRef<string>("");
  const activeEditorContextRef = useRef<null | { relPath: string; label: string; range: null | { startLine: number; endLine: number } }>(null);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ isAuthenticating: boolean; output: string[]; error?: string | null } | null>(null);
  const [commandRegistryTick, setCommandRegistryTick] = useState(0);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelMenuSelectedIndex, setModelMenuSelectedIndex] = useState(0);
  const [modelMenuScrollToIndex, setModelMenuScrollToIndex] = useState<number | null>(null);
  const [fileMenuMode, setFileMenuMode] = useState<null | { kind: "atToken"; start: number; end: number }>(null);
  const [fileMenuResults, setFileMenuResults] = useState<Array<{ relativePath: string; name: string }>>([]);
  const [fileMenuSelectedIndex, setFileMenuSelectedIndex] = useState(0);
  const [fileMenuScrollToIndex, setFileMenuScrollToIndex] = useState<number | null>(null);
  const [fileMenuLoading, setFileMenuLoading] = useState(false);
  const fileMenuIntentRef = useRef<null | "mention" | "attach">(null);
  const fileMenuCleanupOnCloseRef = useRef(false);
  const fileMenuSearchSeqRef = useRef(0);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const commandMenuRef = useRef<HTMLDivElement | null>(null);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const plusTriggerRef = useRef<HTMLButtonElement | null>(null);
  const commandTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const commandRegistryRef = useRef<ClaudeCommandRegistry>(new ClaudeCommandRegistry());

  const projectKey = useMemo(() => `${String(slot)}:${projectRootPath ? String(projectRootPath) : ""}`, [slot, projectRootPath]);

  const bump = useCallback(() => {
    if (scheduledRafRef.current != null) return;
    scheduledRafRef.current = window.requestAnimationFrame(() => {
      scheduledRafRef.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  const copyToClipboard = useCallback(async (text: string) => {
    const value = String(text ?? "");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = value;
        el.style.position = "fixed";
        el.style.left = "-9999px";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      } catch {
        // ignore
      }
    }
  }, []);

  const pushSystemMessage = useCallback(
    (text: string) => {
      const line = String(text ?? "").trim();
      if (!line) return;
      storeRef.current.messages.push({
        id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: "system",
        text: line
      });
      bump();
    },
    [bump]
  );

  const {
    diffSessionId,
    setDiffSessionId,
    isDiffPanelOpen,
    setIsDiffPanelOpen,
    diffFiles,
    setDiffFiles,
    diffQuery,
    setDiffQuery,
    diffStats,
    setDiffStats,
    diffSelectedAbsPath,
    setDiffSelectedAbsPath,
    diffState,
    setDiffState,
    toDisplayPath,
    refreshDiffFiles,
    visibleDiffFiles,
    loadDiffForFile,
    openSelectedFile,
    resetDiffListState
  } = useClaudeDiffPanel({ projectRootPath, pushSystemMessage });

  const {
    isHistoryOpen,
    setIsHistoryOpen,
    historyQuery,
    setHistoryQuery,
    historyLoading,
    visibleHistorySessions,
    refreshHistory,
    loadHistorySession,
    forkHistorySession
  } = useClaudeHistory({
    slot,
    projectRootPath,
    mode,
    isDev,
    storeRef,
    interruptedDraftBySessionIdRef,
    bump,
    pushSystemMessage,
    setIsTurnInProgress,
    setDiffSessionId,
    resetDiffListState
  });

  const ensureStartedAndSyncSession = useCallback(
    async (args: { projectRootPath: string; sessionId?: string | null; permissionMode?: ClaudePermissionMode; forkSession?: boolean }) => {
      const root = String(args.projectRootPath ?? "").trim();
      if (!root) return null;
      try {
        const res = await window.xcoding.claude.ensureStarted({ slot, ...args, projectRootPath: root });
        if (!res?.ok) {
          pushSystemMessage(`Claude ensureStarted failed: ${String(res?.reason ?? "unknown")}`);
          return null;
        }
        const sid = coerceNonEmptyString(res.sessionId);
        if (sid) setDiffSessionId(sid);
        return res;
      } catch (e) {
        pushSystemMessage(`Claude ensureStarted error: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [pushSystemMessage, slot]
  );

  useEffect(() => {
    if (!isActive) return;
    const root = String(projectRootPath ?? "").trim();
    if (!root) {
      setSupportedCommands([]);
      setSupportedModels([]);
      setAccountInfo(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      const ensure = await ensureStartedAndSyncSession({ projectRootPath: root, permissionMode: mode });
      if (!ensure?.ok || cancelled) return;
      const sessionId = typeof ensure.sessionId === "string" && ensure.sessionId.trim() ? ensure.sessionId.trim() : null;

      const [commandsRes, modelsRes, accountRes] = await Promise.all([
        window.xcoding.claude.supportedCommands({ slot, projectRootPath: root, sessionId, permissionMode: mode }),
        window.xcoding.claude.supportedModels({ slot, projectRootPath: root, sessionId, permissionMode: mode }),
        window.xcoding.claude.accountInfo({ slot, projectRootPath: root, sessionId, permissionMode: mode })
      ]);
      if (cancelled) return;

      if (commandsRes?.ok) setSupportedCommands(commandsRes.commands ?? []);
      if (modelsRes?.ok) setSupportedModels(modelsRes.models ?? []);
      if (accountRes?.ok) setAccountInfo(accountRes.accountInfo ?? null);
    })();

    return () => {
      cancelled = true;
    };
  }, [ensureStartedAndSyncSession, isActive, mode, projectRootPath, slot]);

  useEffect(() => {
    const onSelectionChanged = (e: Event) => {
      const detail = (e as CustomEvent)?.detail as any;
      if (!detail || typeof detail !== "object") return;
      if (Number(detail.slot) !== slot) return;

      const relPath = typeof detail.path === "string" ? String(detail.path) : "";
      if (!relPath) return;

      const parts = relPath.split("/").filter(Boolean);
      const label = parts[parts.length - 1] ?? relPath;

      const sel = detail.selection && typeof detail.selection === "object" ? (detail.selection as any) : null;
      const start = sel?.start && typeof sel.start === "object" ? (sel.start as any) : null;
      const end = sel?.end && typeof sel.end === "object" ? (sel.end as any) : null;
      const startLine0 = typeof start?.line === "number" ? Number(start.line) : null;
      const startChar0 = typeof start?.character === "number" ? Number(start.character) : null;
      const endLine0 = typeof end?.line === "number" ? Number(end.line) : null;
      const endChar0 = typeof end?.character === "number" ? Number(end.character) : null;

      const isEmptySelection =
        startLine0 == null || endLine0 == null || startChar0 == null || endChar0 == null ? true : startLine0 === endLine0 && startChar0 === endChar0;

      let range: null | { startLine: number; endLine: number } = null;
      if (!isEmptySelection && startLine0 != null && endLine0 != null) {
        range = {
          startLine: Math.min(startLine0, endLine0) + 1,
          endLine: Math.max(startLine0, endLine0) + 1
        };
      }

      const key = `${relPath}|${range ? `${range.startLine}-${range.endLine}` : ""}`;
      if (activeEditorContextKeyRef.current === key) return;
      activeEditorContextKeyRef.current = key;
      const next = { relPath, label, range };
      activeEditorContextRef.current = next;
      setActiveEditorContext(next);
    };

    window.addEventListener("xcoding:fileSelectionChanged", onSelectionChanged as any);
    return () => window.removeEventListener("xcoding:fileSelectionChanged", onSelectionChanged as any);
  }, [slot]);

  useEffect(() => {
    if (hydratedModeRef.current && (!projectRootPath || !projectRootPath.trim())) return;
    hydratedModeRef.current = true;
    setMode(safeLoadMode(projectKey));
  }, [projectKey, projectRootPath]);

  useEffect(() => {
    const flushStreamEvents = () => {
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      const batch = pendingStreamEventsRef.current;
      if (!batch.length) return;
      pendingStreamEventsRef.current = [];
      for (const ev of batch) applyClaudeStreamEvent(storeRef.current, ev);
      bump();
    };

    const scheduleStreamFlush = (delayMs: number) => {
      if (streamFlushTimerRef.current !== null) return;
      streamFlushTimerRef.current = window.setTimeout(flushStreamEvents, Math.max(0, delayMs));
    };

    const offEvent = window.xcoding.claude.onEvent((payload: any) => {
      const env = payload as ClaudeEventEnvelope;
      if (env?.slot !== slot) return;
      let shouldBump = false;
      if (env.kind === "status") {
        storeRef.current.status = env.status;
        const nextState = String(env.status?.state ?? "");
        if (nextState !== "ready" && nextState !== "starting") setIsTurnInProgress(false);
        shouldBump = true;
      }
      if (env.kind === "stderr") {
        if (!isDev) return;
        const text = String(env.text ?? "");
        const trimmed = text.trim();
        if (trimmed) {
          const prefix = `[Claude][slot ${slot}]`;
          if (/\[ERROR\]/.test(trimmed)) console.error(prefix, trimmed);
          else if (/\[(WARN|WARNING)\]/.test(trimmed)) console.warn(prefix, trimmed);
          else if (/\[INFO\]/.test(trimmed)) console.info(prefix, trimmed);
          else console.log(prefix, trimmed);
        }
      }
      if (env.kind === "log") {
        if (!isDev) return;
        const message = String(env.message ?? "");
        if (message) console.log(`[Claude][slot ${slot}] ${message}`, env.data);
      }
      if (env.kind === "stream") {
        const ev = env.event;
        lastClaudeStreamAtRef.current = Date.now();
        if (ev && typeof ev === "object" && (ev as any).type === "auth_status") {
          const next = {
            isAuthenticating: Boolean((ev as any).isAuthenticating),
            output: Array.isArray((ev as any).output) ? (ev as any).output.map((l: any) => String(l ?? "")) : [],
            error: typeof (ev as any).error === "string" ? String((ev as any).error) : null
          };
          setAuthStatus(next);
          if (next.isAuthenticating || next.error) setIsAuthOpen(true);
          bump();
          return;
        }
        if (ev && typeof ev === "object" && (ev as any).type === "system" && (ev as any).subtype === "init") {
          const model = typeof (ev as any).model === "string" ? String((ev as any).model) : "";
          if (model) setCurrentModel(model);
          const sid = typeof (ev as any).session_id === "string" ? String((ev as any).session_id) : "";
          if (sid) setDiffSessionId(sid);
        }
        const normalized = ev && typeof ev === "object" && (ev as any).type === "stream_event" && (ev as any).event ? (ev as any).event : ev;
        const evType = normalized && typeof normalized === "object" ? String((normalized as any).type ?? "") : "";
        if (evType === "message_start" || evType === "tool_progress") setIsTurnInProgress(true);
        if (evType === "result") setIsTurnInProgress(false);
        // Reduce UI churn on long outputs: batch stream events and render at most every 100ms.
        // Keep key lifecycle transitions effectively immediate.
        pendingStreamEventsRef.current.push(ev);
        if (evType === "message_start" || evType === "result") {
          flushStreamEvents();
        } else {
          scheduleStreamFlush(100);
        }
        shouldBump = false;
      }
      if (shouldBump) bump();
    });
    const offReq = window.xcoding.claude.onRequest((payload: any) => {
      if (payload?.slot !== undefined && Number(payload.slot) !== slot) return;
      const toolName = String(payload.toolName ?? "");
      const requestId = String(payload.requestId ?? "");
      const preview = toProposedDiffCardPreview(payload?.preview);

      const existingApproval = requestId ? storeRef.current.approvals.find((a) => a.requestId === requestId) ?? null : null;
      if (existingApproval) {
        existingApproval.toolInput = payload.toolInput ?? existingApproval.toolInput;
        existingApproval.suggestions = payload.suggestions ?? existingApproval.suggestions;
        existingApproval.toolUseId = payload.toolUseId ? String(payload.toolUseId) : existingApproval.toolUseId;
        if (preview !== null) (existingApproval as any).preview = preview;

        const existingMsg = storeRef.current.messages.find(
          (m) => m?.meta?.kind === "approval" && String(m?.meta?.requestId ?? "") === requestId
        );
        if (existingMsg) {
          existingMsg.meta = {
            ...(existingMsg.meta ?? {}),
            toolInput: payload.toolInput ?? existingMsg.meta.toolInput,
            suggestions: payload.suggestions ?? existingMsg.meta.suggestions,
            toolUseId: payload.toolUseId ? String(payload.toolUseId) : existingMsg.meta.toolUseId,
            ...(preview !== null ? { preview } : {})
          };
        }
        bump();
        return;
      }
      // Insert a synthetic "tool permission" row into the message stream, so approvals happen inline.
      storeRef.current.messages.push({
        id: `perm-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: "system",
        text: `tool_permission: ${toolName || "tool"}`,
        meta: {
          kind: "approval",
          requestId,
          toolName,
          toolInput: payload.toolInput,
          suggestions: payload.suggestions,
          toolUseId: payload.toolUseId ? String(payload.toolUseId) : undefined,
          ...(preview !== null ? { preview } : {})
        }
      });
      storeRef.current.approvals.unshift({
        at: Date.now(),
        requestId,
        sessionId: String(payload.sessionId ?? ""),
        toolName,
        toolInput: payload.toolInput,
        suggestions: payload.suggestions,
        toolUseId: payload.toolUseId ? String(payload.toolUseId) : undefined,
        ...(preview !== null ? { preview } : {})
      });
      setPendingApprovalId(requestId);
      bump();
    });
    return () => {
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      offEvent();
      offReq();
    };
  }, [bump, isDev, slot]);

  const messages = storeRef.current.messages;
  const approvals = storeRef.current.approvals;
  const status = storeRef.current.status;
  const activeApproval = pendingApprovalId ? approvals.find((a) => a.requestId === pendingApprovalId) ?? null : null;

  const stop = useCallback(async () => {
    try {
      // Flush any pending stream updates before interrupting so the UI doesn't "lose" already received deltas.
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      const batch = pendingStreamEventsRef.current;
      if (batch.length) {
        pendingStreamEventsRef.current = [];
        for (const ev of batch) applyClaudeStreamEvent(storeRef.current, ev);
        bump();
      }
      const sid = typeof diffSessionId === "string" ? diffSessionId.trim() : "";
      if (sid) {
        interruptedDraftBySessionIdRef.current.set(
          sid,
          storeRef.current.messages.map((m) => ({ ...m, meta: m.meta ? { ...(m.meta as any) } : undefined }))
        );
      }
      const res = await window.xcoding.claude.interrupt({ slot });
      if (!res?.ok) pushSystemMessage(`Failed to interrupt: ${String(res?.reason ?? "unknown")}`);
    } catch (e) {
      pushSystemMessage(`Failed to interrupt: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsTurnInProgress(false);
    }
  }, [diffSessionId, pushSystemMessage, slot]);

  const send = useCallback(async () => {
    const text = input.trim();
    const files = attachedFiles.slice();
    if (!text && files.length === 0) return;

    const canonicalBodies = files.map((p) => canonicalizeAtMentionBody(p)).filter(Boolean) as string[];
    const uniqueFiles = Array.from(new Map(canonicalBodies.map((p) => [p, p])).values());

    const mentionedPaths = extractAtMentionPathsFromText(text);
    const fileMentions = uniqueFiles
      .filter((body) => {
        const parsed = parseAtMentionBody(body);
        if (!parsed?.path) return true;
        return !mentionedPaths.has(parsed.path);
      })
      .map((p) => `@${p}`);
    const payloadText = fileMentions.length ? (text ? `${text}\n\n${fileMentions.join("\n")}` : fileMentions.join("\n")) : text;

    const msg: ClaudeUiMessage = { id: `u-${Date.now()}`, role: "user", text, ...(uniqueFiles.length ? { meta: { attachedFiles: uniqueFiles } } : {}) };
    storeRef.current.messages.push(msg);

    // Match Codex UX: show an immediate "thinking" placeholder so long first-token latency doesn't look frozen.
    const assistantId = `a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    storeRef.current.streaming.activeAssistantMessageId = assistantId;
    storeRef.current.messages.push({ id: assistantId, role: "assistant", text: "", meta: { kind: "thinkingPlaceholder" } });
    bump();
    setInput("");
    setAttachedFiles([]);
    setIsTurnInProgress(true);
    try {
      const beforeStreamAt = lastClaudeStreamAtRef.current;
      const res = await window.xcoding.claude.sendUserMessage({
        slot,
        projectRootPath: projectRootPath || "",
        sessionId: diffSessionId ?? null,
        permissionMode: mode,
        content: payloadText
      });
      if (!res?.ok) {
        pushSystemMessage(`Failed to send message: ${String(res?.reason ?? "unknown")}`);
        setIsTurnInProgress(false);
        return;
      }
      const sid = typeof res?.sessionId === "string" ? res.sessionId.trim() : "";
      if (sid) setDiffSessionId(sid);
      const inProgressAt = Date.now();
      window.setTimeout(() => {
        if (lastClaudeStreamAtRef.current !== beforeStreamAt) return;
        pushSystemMessage("Claude has not started responding yet (no stream events). Check Claude login/auth status, or try reopening the Claude panel.");
        if (Date.now() - inProgressAt >= 1900) setIsTurnInProgress(false);
      }, 2000);
    } catch (e) {
      pushSystemMessage(`Failed to send message: ${e instanceof Error ? e.message : String(e)}`);
      setIsTurnInProgress(false);
    }

    const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (cmd === "/clear") {
      // Claude Code clears the session context; mirror by clearing local UI state and reloading history.
      storeRef.current.messages = [];
      storeRef.current.approvals = [];
      setPendingApprovalId(null);
      setDiffFiles([]);
      setDiffQuery("");
      setDiffStats({});
      setDiffSelectedAbsPath("");
      setDiffState({ loading: false, original: "", modified: "", unifiedDiff: "", unifiedTruncated: false });
      setIsTurnInProgress(false);
      bump();
      void refreshHistory();
    }
  }, [
    attachedFiles,
    bump,
    diffSessionId,
    ensureStartedAndSyncSession,
    input,
    isDev,
    mode,
    projectRootPath,
    pushSystemMessage,
    refreshHistory,
    slot
  ]);

  const setModeAndPersist = useCallback(
    async (next: ClaudePermissionMode) => {
      const prev = mode;
      setMode(next);
      persistMode(projectKey, next);
      try {
        const res = await window.xcoding.claude.setPermissionMode({ slot, mode: next });
        if (!res?.ok) throw new Error(String(res?.reason ?? "setPermissionMode_failed"));
      } catch (e) {
        setMode(prev);
        persistMode(projectKey, prev);
        pushSystemMessage(`Failed to set mode: ${e instanceof Error ? e.message : String(e)}`);
        try {
          await window.xcoding.claude.setPermissionMode({ slot, mode: prev });
        } catch {
          // ignore
        }
      }
    },
    [mode, projectKey, pushSystemMessage, slot]
  );

  const respondApproval = useCallback(
    async (behavior: "allow" | "deny", forSession: boolean, options?: { message?: string; interrupt?: boolean }) => {
      if (!activeApproval) return;
      try {
        const res = await window.xcoding.claude.respondToolPermission({
          requestId: activeApproval.requestId,
          behavior,
          updatedInput: activeApproval.toolInput,
          updatedPermissions: behavior === "allow" && forSession ? activeApproval.suggestions : undefined,
          message: options?.message,
          interrupt: options?.interrupt ?? behavior === "deny"
        });
        if (!res?.ok) pushSystemMessage(`Failed to respond approval: ${String(res?.reason ?? "unknown")}`);
      } catch (e) {
        pushSystemMessage(`Failed to respond approval: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setPendingApprovalId(null);
      }
    },
    [activeApproval, pushSystemMessage]
  );

  // re-render dependency
  void version;

  const bottomKey = useMemo(() => {
    const count = messages.length;
    const last = count ? messages[count - 1] : null;
    const lastLen = last ? String(last.text ?? "").length : 0;
    const state = String(status?.state ?? "");
    return `${count}:${lastLen}:${state}`;
  }, [messages, status?.state]);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [bottomKey]);

  useEffect(() => {
    if (!isDiffPanelOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsDiffPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDiffPanelOpen]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    isNearBottomRef.current = dist <= 24;
  };

  const markdownComponents = useClaudeMarkdownComponents({ slot, onOpenUrl, onOpenFile, pushSystemMessage });

  const isCommandMenuOpen = commandMenuMode !== null;
  const suppressCommandFilter = commandMenuMode?.kind === "slashToken";
  const isFileMenuOpen = fileMenuMode !== null;

  const closeCommandMenu = useCallback(() => {
    setCommandMenuMode(null);
    setCommandFilter("");
    setCommandMenuActiveId(null);
    setCommandMenuScrollToId(null);
  }, []);

  const closeModelMenu = useCallback(() => {
    setIsModelMenuOpen(false);
    setModelMenuScrollToIndex(null);
  }, []);

  const closeFileMenu = useCallback(
    (options?: { cleanupToken?: boolean }) => {
      const cleanupToken = Boolean(options?.cleanupToken);
      if (cleanupToken && fileMenuMode?.kind === "atToken") {
        const { start, end } = fileMenuMode;
        const before = input.slice(0, start);
        const after = input.slice(end);
        let nextBefore = before;
        // If we inserted a temporary mention for attach, try to remove the extra separating space too.
        if (nextBefore.endsWith(" ") && (!after || /^\s/.test(after))) nextBefore = nextBefore.slice(0, -1);
        const next = `${nextBefore}${after}`;
        setInput(next);
        requestAnimationFrame(() => {
          try {
            inputRef.current?.focus();
            const caret = nextBefore.length;
            inputRef.current?.setSelectionRange(caret, caret);
          } catch {
            // ignore
          }
        });
      }
      setFileMenuMode(null);
      setFileMenuResults([]);
      setFileMenuSelectedIndex(0);
      setFileMenuScrollToIndex(null);
      setFileMenuLoading(false);
      fileMenuIntentRef.current = null;
      fileMenuCleanupOnCloseRef.current = false;
    },
    [fileMenuMode, input]
  );

  function touchCommandRegistry() {
    setCommandRegistryTick((v) => v + 1);
  }

  const openLoginInTerminal = useCallback(async () => {
    if (!projectRootPath) return;
    const res = await window.xcoding.claude.buildOpenInTerminalCommand({ slot, resumeSessionId: diffSessionId ?? null, initialInput: "/login" });
    if (!res?.ok || !res.command) {
      pushSystemMessage(`Failed to build terminal command: ${String(res?.reason ?? "unknown")}`);
      return;
    }
    if (typeof onOpenTerminalAndRun === "function") onOpenTerminalAndRun(String(res.command), { title: "Claude Code" });
    else pushSystemMessage("Terminal integration is not wired.");
  }, [diffSessionId, onOpenTerminalAndRun, projectRootPath, pushSystemMessage, slot]);

  const startLogin = useCallback(async () => {
    if (!projectRootPath) return;
    setIsPlusMenuOpen(false);
    closeCommandMenu();
    closeFileMenu();
    closeModelMenu();

    setIsAuthOpen(true);
    setAuthStatus((prev) => prev ?? { isAuthenticating: true, output: [], error: null });

    const ensure = await ensureStartedAndSyncSession({ projectRootPath: String(projectRootPath), permissionMode: mode });
    if (!ensure?.ok) return;
    const res = await window.xcoding.claude.sendUserMessage({ slot, content: "/login", isSynthetic: true });
    if (!res?.ok) pushSystemMessage(`Failed to start login: ${String(res?.reason ?? "unknown")}`);
  }, [closeCommandMenu, closeFileMenu, closeModelMenu, ensureStartedAndSyncSession, mode, projectRootPath, pushSystemMessage, slot]);

  const submitOAuthCode = useCallback(
    async (rawCode: string) => {
      if (!projectRootPath) return;
      const code = String(rawCode ?? "").trim();
      if (!code) return;
      const ensure = await ensureStartedAndSyncSession({ projectRootPath: String(projectRootPath), permissionMode: mode });
      if (!ensure?.ok) return;
      const res = await window.xcoding.claude.sendUserMessage({ slot, content: code, isSynthetic: true });
      if (!res?.ok) pushSystemMessage(`Failed to submit code: ${String(res?.reason ?? "unknown")}`);
    },
    [ensureStartedAndSyncSession, mode, projectRootPath, pushSystemMessage, slot]
  );

  const mentionActiveSelection = useCallback(() => {
    const ctx = activeEditorContextRef.current;
    if (!ctx?.relPath) {
      pushSystemMessage("No active editor selection to mention.");
      return;
    }
    const token = formatAtMentionToken(ctx.relPath, ctx.range);

    const el = inputRef.current;
    const text = input;
    const start = typeof el?.selectionStart === "number" ? el.selectionStart : text.length;
    const end = typeof el?.selectionEnd === "number" ? el.selectionEnd : start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const prefixSpace = before && !/\s$/.test(before) ? " " : "";
    const suffixSpace = after && !/^\s/.test(after) ? " " : "";
    const insert = `${prefixSpace}${token}${suffixSpace}`;
    const next = `${before}${insert}${after}`;
    setInput(next);
    requestAnimationFrame(() => {
      try {
        el?.focus();
        const caret = before.length + insert.length;
        el?.setSelectionRange(caret, caret);
      } catch {
        // ignore
      }
    });
  }, [input, pushSystemMessage]);

  const attachActiveSelection = useCallback(() => {
    const ctx = activeEditorContextRef.current;
    if (!ctx?.relPath) {
      pushSystemMessage("No active editor selection to attach.");
      return;
    }
    const { range } = ctx;
    if (!range) {
      pushSystemMessage("No selection to attach (select some text in the editor first).");
      return;
    }
    const body = formatAtMentionBody(ctx.relPath, range);
    setAttachedFiles((prev) => (prev.includes(body) ? prev : [...prev, body]));
  }, [pushSystemMessage]);

  const insertOrReplaceSlashCommand = useCallback(
    (raw: string) => {
      const cmd = String(raw ?? "").trim();
      if (!cmd) return;
      const insert = cmd.endsWith(" ") ? cmd : `${cmd} `;
      const el = inputRef.current;
      const text = input;

      if (commandMenuMode?.kind === "slashToken") {
        const { start, end } = commandMenuMode;
        const next = `${text.slice(0, start)}${insert}${text.slice(end)}`;
        setInput(next);
        requestAnimationFrame(() => {
          try {
            el?.focus();
            const caret = start + insert.length;
            el?.setSelectionRange(caret, caret);
          } catch {
            // ignore
          }
        });
        return;
      }

      setInput(insert);
      requestAnimationFrame(() => {
        try {
          el?.focus();
          const caret = insert.length;
          el?.setSelectionRange(caret, caret);
        } catch {
          // ignore
        }
      });
    },
    [commandMenuMode, input]
  );

  const openFilePicker = useCallback(
    (intent: "mention" | "attach") => {
      if (!projectRootPath) return;
      setIsPlusMenuOpen(false);
      closeCommandMenu();
      closeModelMenu();

      const el = inputRef.current;
      const text = input;
      const cursor = typeof el?.selectionStart === "number" ? el.selectionStart : text.length;
      const existing = findAtToken(text, cursor);
      if (existing) {
        fileMenuIntentRef.current = intent;
        fileMenuCleanupOnCloseRef.current = false;
        setFileMenuMode({ kind: "atToken", start: existing.start, end: existing.end });
        setFileMenuSelectedIndex(0);
        setFileMenuScrollToIndex(null);
        requestAnimationFrame(() => el?.focus());
        return;
      }

      const prefixSpace = cursor > 0 && !/\s/.test(text[cursor - 1] || "") ? " " : "";
      const insert = `${prefixSpace}@`;
      const next = `${text.slice(0, cursor)}${insert}${text.slice(cursor)}`;
      fileMenuIntentRef.current = intent;
      fileMenuCleanupOnCloseRef.current = intent === "attach";
      setInput(next);
      requestAnimationFrame(() => {
        try {
          el?.focus();
          const caret = cursor + insert.length;
          el?.setSelectionRange(caret, caret);
        } catch {
          // ignore
        }
        const token = findAtToken(next, cursor + insert.length);
        if (token) setFileMenuMode({ kind: "atToken", start: token.start, end: token.end });
      });
    },
    [closeCommandMenu, closeModelMenu, input, projectRootPath]
  );

  const applyPickedFile = useCallback(
    (relativePath: string, viaTab: boolean) => {
      const rel = String(relativePath ?? "").trim().replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/");
      if (!rel) return;
      if (!fileMenuMode || fileMenuMode.kind !== "atToken") return;
      const { start, end } = fileMenuMode;

      const intent = fileMenuIntentRef.current ?? "mention";
      if (intent === "attach") {
        const body = formatAtMentionBody(rel, null);
        setAttachedFiles((prev) => (prev.includes(body) ? prev : [...prev, body]));
        const before = input.slice(0, start);
        const after = input.slice(end);
        let nextBefore = before;
        if (nextBefore.endsWith(" ") && (!after || /^\s/.test(after))) nextBefore = nextBefore.slice(0, -1);
        const next = `${nextBefore}${after}`;
        setInput(next);
        closeFileMenu();
        requestAnimationFrame(() => {
          try {
            inputRef.current?.focus();
            const caret = nextBefore.length;
            inputRef.current?.setSelectionRange(caret, caret);
          } catch {
            // ignore
          }
        });
        return;
      }

      const insert = formatAtMentionToken(rel, null);
      const before = input.slice(0, start);
      const after = input.slice(end);
      const needsSpaceAfter = after.length > 0 && !/^\s/.test(after);
      const next = `${before}${insert}${needsSpaceAfter ? " " : ""}${after}`;
      setInput(next);
      closeFileMenu();
      requestAnimationFrame(() => {
        try {
          inputRef.current?.focus();
          const caret = before.length + insert.length + (needsSpaceAfter ? 1 : 0);
          inputRef.current?.setSelectionRange(caret, caret);
        } catch {
          // ignore
        }
      });
      void viaTab;
    },
    [closeFileMenu, fileMenuMode, input]
  );

  const fileSearchQuery = useMemo(() => {
    if (!fileMenuMode || fileMenuMode.kind !== "atToken") return "";
    const start = Math.max(0, Math.min(input.length, fileMenuMode.start + 1));
    const end = Math.max(start, Math.min(input.length, fileMenuMode.end));
    return input.slice(start, end);
  }, [fileMenuMode, input]);

  useEffect(() => {
    if (!isFileMenuOpen) return;
    if (!projectRootPath) return;

    const q = fileSearchQuery.trim();
    if (!q) {
      setFileMenuLoading(false);
      setFileMenuResults([]);
      setFileMenuSelectedIndex(0);
      setFileMenuScrollToIndex(null);
      return;
    }

    const seq = (fileMenuSearchSeqRef.current += 1);
    setFileMenuLoading(true);
    const timer = window.setTimeout(() => {
      void window.xcoding.project
        .searchFiles({ slot, query: q, maxResults: 200 })
        .then((res) => {
          if (fileMenuSearchSeqRef.current !== seq) return;
          if (!res?.ok) {
            setFileMenuLoading(false);
            setFileMenuResults([]);
            setFileMenuScrollToIndex(null);
            return;
          }
          setFileMenuLoading(false);
          setFileMenuResults(res.results ?? []);
          setFileMenuSelectedIndex(0);
          setFileMenuScrollToIndex(null);
        })
        .catch(() => {
          if (fileMenuSearchSeqRef.current !== seq) return;
          setFileMenuLoading(false);
          setFileMenuResults([]);
          setFileMenuScrollToIndex(null);
        });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [fileSearchQuery, isFileMenuOpen, projectRootPath, slot]);

  const modelMenuModels = useMemo(() => {
    const merged = [{ value: "default", displayName: "Default", description: "Let Claude Code choose" }, ...supportedModels].filter((m) => m.value);
    return Array.from(new Map(merged.map((m) => [m.value, m])).values());
  }, [supportedModels]);

  const modelSelectOptions = useMemo(() => {
    const base = [
      { value: "default", label: "Default" },
      ...supportedModels
        .filter((m) => m.value && m.value !== "default")
        .map((m) => ({ value: m.value, label: m.displayName || m.value }))
    ];
    const uniq = new Map<string, { value: string; label: string }>();
    for (const o of base) {
      if (!o.value) continue;
      if (!uniq.has(o.value)) uniq.set(o.value, o);
    }
    if (currentModel && !uniq.has(currentModel)) uniq.set(currentModel, { value: currentModel, label: currentModel });
    return Array.from(uniq.values());
  }, [currentModel, supportedModels]);

  const selectModel = useCallback(
    async (value: string, viaTab: boolean) => {
      if (!projectRootPath) return;
      const nextValue = String(value ?? "").trim() || "default";
      const ensure = await ensureStartedAndSyncSession({ projectRootPath: String(projectRootPath), permissionMode: mode });
      if (!ensure?.ok) return;
      const res = await window.xcoding.claude.setModel({ slot, model: nextValue === "default" ? undefined : nextValue });
      if (!res?.ok) {
        pushSystemMessage(`Failed to set model: ${String(res?.reason ?? "unknown")}`);
        return;
      }
      setCurrentModel(nextValue);
      closeModelMenu();
      void viaTab;
    },
    [closeModelMenu, ensureStartedAndSyncSession, mode, projectRootPath, pushSystemMessage, slot]
  );

  const setThinking = useCallback(
    async (next: boolean) => {
      if (!projectRootPath) return;
      const prev = thinkingEnabled;
      setThinkingEnabled(next);
      const ensure = await ensureStartedAndSyncSession({ projectRootPath: String(projectRootPath), permissionMode: mode });
      if (!ensure?.ok) {
        setThinkingEnabled(prev);
        return;
      }
      const res = await window.xcoding.claude.setMaxThinkingTokens({ slot, maxThinkingTokens: next ? 31999 : 0 });
      if (!res?.ok) {
        setThinkingEnabled(prev);
        pushSystemMessage(`Failed to toggle thinking: ${String(res?.reason ?? "unknown")}`);
      }
    },
    [ensureStartedAndSyncSession, mode, projectRootPath, pushSystemMessage, slot, thinkingEnabled]
  );

  const toggleThinking = useCallback(() => {
    void setThinking(!thinkingEnabled);
  }, [setThinking, thinkingEnabled]);

  useEffect(() => {
    const registry = commandRegistryRef.current;
    registry.registerAction({ id: "attach-file", label: "Attach file…" }, "Context", () => {
      openFilePicker("attach");
    });
    registry.registerAction({ id: "mention-file", label: "Mention file from this project…" }, "Context", () => {
      openFilePicker("mention");
    });

    registry.registerAction({ id: "mcp-config", label: "MCP status" }, "Customize", () => {
      setIsSettingsOpen(true);
    });
    registry.registerAction(
      { id: "slash-command-config", label: "General config…", description: "Open Claude configuration" },
      "Settings",
      () => setIsSettingsOpen(true)
    );
    registry.registerAction(
      {
        id: "slash-command-terminal",
        label: "Open Claude in Terminal",
        description: "Open a new Claude instance in the Terminal",
        trailingComponent: <ExternalLink className="h-4 w-4 text-[var(--vscode-descriptionForeground)]" />
      },
      "Customize",
      async () => {
        if (!projectRootPath) return;
        const res = await window.xcoding.claude.buildOpenInTerminalCommand({ slot, resumeSessionId: diffSessionId ?? null });
        if (!res?.ok || !res.command) {
          pushSystemMessage(`Failed to build terminal command: ${String(res?.reason ?? "unknown")}`);
          return;
        }
        if (typeof onOpenTerminalAndRun === "function") onOpenTerminalAndRun(String(res.command), { title: "Claude Code" });
        else pushSystemMessage("Terminal integration is not wired.");
      }
    );

    registry.registerAction({ id: "clear-conversation", label: "Clear conversation" }, "Context", async () => {
      storeRef.current.messages = [];
      storeRef.current.approvals = [];
      setPendingApprovalId(null);
      setDiffFiles([]);
      setDiffQuery("");
      setDiffStats({});
      setDiffSelectedAbsPath("");
      setDiffSessionId(null);
      setDiffState({ loading: false, original: "", modified: "", unifiedDiff: "", unifiedTruncated: false });
      setIsTurnInProgress(false);
      bump();
      try {
        await window.xcoding.claude.close({ slot });
      } catch {
        // ignore
      }
      void refreshHistory();
    });

    registry.registerAction({ id: "new-conversation", label: "New conversation", filterOnly: true }, "Context", async () => {
      storeRef.current.messages = [];
      storeRef.current.approvals = [];
      setPendingApprovalId(null);
      setDiffFiles([]);
      setDiffQuery("");
      setDiffStats({});
      setDiffSelectedAbsPath("");
      setDiffSessionId(null);
      setDiffState({ loading: false, original: "", modified: "", unifiedDiff: "", unifiedTruncated: false });
      setIsTurnInProgress(false);
      bump();
      try {
        await window.xcoding.claude.close({ slot });
      } catch {
        // ignore
      }
      void refreshHistory();
    });

    registry.registerAction({ id: "resume-conversation", label: "Resume conversation", filterOnly: true }, "Context", () => {
      setIsHistoryOpen(true);
      void refreshHistory();
    });

    registry.registerAction({ id: "login", label: "Switch account" }, "Settings", () => {
      void startLogin();
    });
    registry.registerAction({ id: "login-alias", label: "/login", filterOnly: true }, "Settings", () => {
      void startLogin();
    });

    touchCommandRegistry();
  }, [
    bump,
    closeCommandMenu,
    closeFileMenu,
    diffSessionId,
    ensureStartedAndSyncSession,
    insertOrReplaceSlashCommand,
    mode,
    openFilePicker,
    onOpenTerminalAndRun,
    startLogin,
    projectRootPath,
    pushSystemMessage,
    refreshHistory,
    setThinking,
    slot,
    supportedModels
  ]);

  useEffect(() => {
    const registry = commandRegistryRef.current;
    registry.unregisterByPrefix("slash-command-");
    for (const c of supportedCommands) {
      const name = String(c?.name ?? "").trim();
      if (!name) continue;
      registry.registerAction({ id: `slash-command-${name}`, label: `/${name}`, description: String(c?.description ?? "") }, "Slash Commands", () => {
        insertOrReplaceSlashCommand(`/${name}`);
      });
    }
    touchCommandRegistry();
  }, [insertOrReplaceSlashCommand, supportedCommands]);

  useEffect(() => {
    const onDismiss = () => {
      setIsPlusMenuOpen(false);
      closeCommandMenu();
      closeFileMenu();
      closeModelMenu();
    };
    window.addEventListener("xcoding:dismissOverlays", onDismiss as any);
    return () => window.removeEventListener("xcoding:dismissOverlays", onDismiss as any);
  }, [closeCommandMenu, closeFileMenu, closeModelMenu]);

  const commandMenuSections = useMemo(() => {
    void commandRegistryTick;
    const registry = commandRegistryRef.current;
    const q = commandFilter.trim().toLowerCase();
    const includeFilterOnly = q.length > 0;
    const bySection = registry.getCommandsBySection(includeFilterOnly);
    if (!q) return { filtered: bySection, flat: Object.values(bySection).flat() };
    const filtered: Record<string, ClaudeRegisteredCommand[]> = {};
    for (const [section, cmds] of Object.entries(bySection)) {
      const keep = cmds.filter((c) => c.label.toLowerCase().includes(q));
      if (keep.length) filtered[section] = keep;
    }
    return { filtered, flat: Object.values(filtered).flat() };
  }, [commandFilter, commandRegistryTick]);

  useEffect(() => {
    if (!isCommandMenuOpen) return;
    if (suppressCommandFilter) return;
    setCommandMenuActiveId(null);
    setCommandMenuScrollToId(null);
  }, [isCommandMenuOpen, suppressCommandFilter]);

  useEffect(() => {
    if (!isCommandMenuOpen) return;
    const q = commandFilter.trim();
    if (!q) {
      setCommandMenuActiveId(null);
      return;
    }
    const flat = commandMenuSections.flat;
    if (flat.length === 0) {
      setCommandMenuActiveId(null);
      return;
    }
    if (commandMenuActiveId && flat.some((c) => c.id === commandMenuActiveId)) return;
    setCommandMenuActiveId(flat[0]?.id ?? null);
  }, [commandFilter, commandMenuActiveId, commandMenuSections.flat, isCommandMenuOpen]);

  const handleCommandMenuKeyDown = useCallback(
    (e: KeyboardEvent | React.KeyboardEvent) => {
      const key = e.key;
      const flat = commandMenuSections.flat;
      if (key === "Escape") {
        e.preventDefault();
        closeCommandMenu();
        return;
      }
      if (key === "ArrowDown" && flat.length > 0) {
        e.preventDefault();
        const idx = flat.findIndex((c) => c.id === commandMenuActiveId);
        const next = flat[idx >= 0 && idx < flat.length - 1 ? idx + 1 : 0]?.id ?? null;
        setCommandMenuActiveId(next);
        setCommandMenuScrollToId(next);
        return;
      }
      if (key === "ArrowUp" && flat.length > 0) {
        e.preventDefault();
        const idx = flat.findIndex((c) => c.id === commandMenuActiveId);
        const next = flat[idx > 0 ? idx - 1 : flat.length - 1]?.id ?? null;
        setCommandMenuActiveId(next);
        setCommandMenuScrollToId(next);
        return;
      }
      if ((key === "Enter" || key === "Tab") && !(e as any).shiftKey) {
        if ("isComposing" in e && (e as any).isComposing) return;
        if (!commandMenuActiveId) return;
        const cmd = flat.find((c) => c.id === commandMenuActiveId) ?? null;
        if (!cmd) return;
        e.preventDefault();
        cmd.run({ viaTab: key === "Tab" });
        if (!cmd.keepMenuOpen) closeCommandMenu();
        return;
      }
    },
    [closeCommandMenu, commandMenuActiveId, commandMenuSections.flat]
  );

  useEffect(() => {
    if (!isCommandMenuOpen) return;
    if (!suppressCommandFilter) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) handleCommandMenuKeyDown(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCommandMenuKeyDown, isCommandMenuOpen, suppressCommandFilter]);

  const handleFileMenuKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isFileMenuOpen) return;
      const key = e.key;
      if (key === "Escape") {
        e.preventDefault();
        if (fileMenuCleanupOnCloseRef.current) closeFileMenu({ cleanupToken: true });
        else closeFileMenu();
        return;
      }
      if (key === "ArrowDown" && fileMenuResults.length > 1) {
        e.preventDefault();
        const next = fileMenuSelectedIndex < fileMenuResults.length - 1 ? fileMenuSelectedIndex + 1 : 0;
        setFileMenuSelectedIndex(next);
        setFileMenuScrollToIndex(next);
        return;
      }
      if (key === "ArrowUp" && fileMenuResults.length > 1) {
        e.preventDefault();
        const next = fileMenuSelectedIndex > 0 ? fileMenuSelectedIndex - 1 : fileMenuResults.length - 1;
        setFileMenuSelectedIndex(next);
        setFileMenuScrollToIndex(next);
        return;
      }
      if ((key === "Enter" || key === "Tab") && !(e as any).shiftKey) {
        if ("isComposing" in e && (e as any).isComposing) return;
        const picked = fileMenuResults[fileMenuSelectedIndex];
        if (!picked?.relativePath) return;
        e.preventDefault();
        applyPickedFile(picked.relativePath, key === "Tab");
        return;
      }
    },
    [applyPickedFile, closeFileMenu, fileMenuResults, fileMenuSelectedIndex, isFileMenuOpen]
  );

  useEffect(() => {
    if (!isFileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) handleFileMenuKeyDown(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleFileMenuKeyDown, isFileMenuOpen]);

  const handleModelMenuKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isModelMenuOpen) return;
      const key = e.key;
      if (key === "Escape") {
        e.preventDefault();
        closeModelMenu();
        return;
      }
      if (key === "ArrowDown" && modelMenuModels.length > 1) {
        e.preventDefault();
        const next = modelMenuSelectedIndex < modelMenuModels.length - 1 ? modelMenuSelectedIndex + 1 : 0;
        setModelMenuSelectedIndex(next);
        setModelMenuScrollToIndex(next);
        return;
      }
      if (key === "ArrowUp" && modelMenuModels.length > 1) {
        e.preventDefault();
        const next = modelMenuSelectedIndex > 0 ? modelMenuSelectedIndex - 1 : modelMenuModels.length - 1;
        setModelMenuSelectedIndex(next);
        setModelMenuScrollToIndex(next);
        return;
      }
      if ((key === "Enter" || key === "Tab") && !(e as any).shiftKey) {
        if ("isComposing" in e && (e as any).isComposing) return;
        const picked = modelMenuModels[modelMenuSelectedIndex];
        if (!picked?.value) return;
        e.preventDefault();
        void selectModel(picked.value, key === "Tab");
        return;
      }
    },
    [closeModelMenu, isModelMenuOpen, modelMenuModels, modelMenuSelectedIndex, selectModel]
  );

  useEffect(() => {
    if (!isModelMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) handleModelMenuKeyDown(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleModelMenuKeyDown, isModelMenuOpen]);

  useEffect(() => {
    if (!isPlusMenuOpen && !isCommandMenuOpen && !isFileMenuOpen && !isModelMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        setIsPlusMenuOpen(false);
        closeCommandMenu();
        if (fileMenuCleanupOnCloseRef.current) closeFileMenu({ cleanupToken: true });
        else closeFileMenu();
        closeModelMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    // Click-away close (capture so it's reliable).
    const onPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target) {
        if (plusMenuRef.current && plusMenuRef.current.contains(target)) return;
        if (commandMenuRef.current && commandMenuRef.current.contains(target)) return;
        if (fileMenuRef.current && fileMenuRef.current.contains(target)) return;
        if (modelMenuRef.current && modelMenuRef.current.contains(target)) return;
        if (plusTriggerRef.current && plusTriggerRef.current.contains(target)) return;
        if (commandTriggerRef.current && commandTriggerRef.current.contains(target)) return;
      }
      setIsPlusMenuOpen(false);
      closeCommandMenu();
      if (fileMenuCleanupOnCloseRef.current) closeFileMenu({ cleanupToken: true });
      else closeFileMenu();
      closeModelMenu();
    };
    window.addEventListener("pointerdown", onPointerDownCapture, { capture: true } as any);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDownCapture, { capture: true } as any);
    };
  }, [closeCommandMenu, closeFileMenu, closeModelMenu, isCommandMenuOpen, isFileMenuOpen, isModelMenuOpen, isPlusMenuOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--vscode-sideBar-background)]">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-glass-border bg-glass-bg px-2 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">{t("claudeCode")}</div>
          <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">{status?.state ?? "idle"}</div>
          <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">{modeLabel(mode)}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => {
              if (!diffSessionId) return;
              setIsDiffPanelOpen((v) => !v);
              if (!isDiffPanelOpen) void refreshDiffFiles();
            }}
            type="button"
            title={t("toggleDiffPanel")}
            disabled={!projectRootPath || !diffSessionId}
          >
            <FileDiff className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => {
              setIsHistoryOpen((v) => !v);
              void refreshHistory();
            }}
            type="button"
            title={t("history")}
            disabled={!projectRootPath}
          >
            <HistoryIcon className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={() => {
              setIsSettingsOpen(true);
            }}
            type="button"
            title={t("settings")}
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
            onClick={() => {
              storeRef.current.messages = [];
              storeRef.current.approvals = [];
              setPendingApprovalId(null);
              setDiffSessionId(null);
              setIsDiffPanelOpen(false);
              setDiffFiles([]);
              setDiffSelectedAbsPath("");
              setDiffState({ loading: false, original: "", modified: "" });
              setIsTurnInProgress(false);
              bump();
              void (async () => {
                try {
                  const res = await window.xcoding.claude.close({ slot });
                  if (!res?.ok) pushSystemMessage(`Failed to close session: ${String(res?.reason ?? "unknown")}`);
                } catch (e) {
                  pushSystemMessage(`Failed to close session: ${e instanceof Error ? e.message : String(e)}`);
                }
                if (projectRootPath) await ensureStartedAndSyncSession({ projectRootPath, permissionMode: mode });
              })();
            }}
            type="button"
            title={t("newSession")}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

      </div>

      {/* Approvals are rendered inline in the message stream. */}

      <ClaudeHistoryOverlay
        open={isHistoryOpen}
        t={t}
        projectRootPath={projectRootPath}
        query={historyQuery}
        onChangeQuery={setHistoryQuery}
        isLoading={historyLoading}
        onRefresh={refreshHistory}
        sessions={visibleHistorySessions}
        onClose={() => setIsHistoryOpen(false)}
        onLoadSession={loadHistorySession}
        onForkSession={forkHistorySession}
      />

      <div className="relative min-h-0 flex-1">
        <ClaudeAuthModal
          open={isAuthOpen}
          status={authStatus}
          onClose={() => setIsAuthOpen(false)}
          onOpenUrl={onOpenUrl}
          onSubmitCode={(code) => void submitOAuthCode(code)}
          onOpenInTerminal={() => void openLoginInTerminal()}
        />

        <ClaudeSettingsModal
          open={isSettingsOpen}
          slot={slot}
          projectRootPath={projectRootPath}
          permissionMode={mode}
          onClose={() => setIsSettingsOpen(false)}
        />

        <div className="flex h-full min-h-0">
          <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto p-2">
            {messages.length === 0 ? (
              <div />
            ) : (
              messages.map((m: ClaudeUiMessage) => {
                const meta = m.meta && typeof m.meta === "object" ? (m.meta as any) : null;

                if (meta?.kind === "approval") {
                  const rowId = m.id;
                  const open = Object.prototype.hasOwnProperty.call(openById, rowId) ? openById[rowId] : true;
                  const toolName = String(meta.toolName ?? m.text ?? "tool");
                  const reqId = String(meta.requestId ?? "");
                  const isActive = pendingApprovalId && reqId && pendingApprovalId === reqId;
                  const preview = meta?.preview as ProposedDiffCardPreview | undefined;
                  return (
                    <div key={rowId} className="mb-2 px-2">
                      <button
                        type="button"
                        className={[
                          "group inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] leading-4",
                          "hover:bg-[var(--vscode-toolbar-hoverBackground)] focus:outline-none",
                          open ? "bg-[var(--vscode-toolbar-hoverBackground)]" : ""
                        ].join(" ")}
                        onClick={() => setOpenById((prev) => ({ ...prev, [rowId]: !open }))}
                        title={toolName}
                      >
                        <span className="truncate text-[color-mix(in_srgb,var(--vscode-focusBorder)_85%,white)]">Approval required</span>
                        <span className="truncate text-[var(--vscode-descriptionForeground)]">·</span>
                        <span className="truncate text-[var(--vscode-foreground)]">{toolName}</span>
                      </button>
                      {open ? (
                        <div className="mt-1 grid gap-2 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
                          {preview ? <ProposedDiffCard preview={preview} /> : null}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">Tool input</div>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                              onClick={() => void copyToClipboard(formatJson(meta.toolInput ?? null))}
                            >
                              <Copy className="h-3.5 w-3.5" />
                              Copy
                            </button>
                          </div>
                          <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/10 p-2 text-[11px] text-[var(--vscode-foreground)]">
                            {formatJson(meta.toolInput ?? null)}
                          </pre>
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
                              onClick={() => void respondApproval("allow", false)}
                              type="button"
                              disabled={!isActive}
                            >
                              Accept (once)
                            </button>
                            <button
                              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
                              onClick={() => void respondApproval("allow", true)}
                              type="button"
                              disabled={!isActive}
                            >
                              Accept (session)
                            </button>
                            <button
                              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
                              onClick={() => void respondApproval("deny", false, { message: OFFICIAL_DENY_MESSAGE, interrupt: true })}
                              type="button"
                              disabled={!isActive}
                            >
                              Decline
                            </button>
                            {mode === "plan" ? (
                              <button
                                className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
                                onClick={() => void respondApproval("deny", false, { message: OFFICIAL_STAY_IN_PLAN_MESSAGE, interrupt: false })}
                                type="button"
                                disabled={!isActive}
                              >
                                Stay in plan mode
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                }

                if (m.role === "system") {
                  const parsed = parseToolMessage(m.text);
                  if (parsed) {
                    const rowId = m.id;
                    const open = Object.prototype.hasOwnProperty.call(openById, rowId) ? openById[rowId] : parsed.kind === "tool_result";
                    const statusCls =
                      parsed.kind === "tool_result" && parsed.title.toLowerCase().includes("error")
                        ? "text-[color-mix(in_srgb,#f14c4c_90%,white)]"
                        : parsed.kind === "tool_result"
                          ? "text-[color-mix(in_srgb,#89d185_90%,white)]"
                          : "text-[color-mix(in_srgb,var(--vscode-focusBorder)_85%,white)]";
                    return (
                      <div key={rowId} className="mb-1 px-2">
                        <button
                          type="button"
                          className={[
                            "group inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] leading-4",
                            "hover:bg-[var(--vscode-toolbar-hoverBackground)] focus:outline-none",
                            open ? "bg-[var(--vscode-toolbar-hoverBackground)]" : ""
                          ].join(" ")}
                          onClick={() => setOpenById((prev) => ({ ...prev, [rowId]: !open }))}
                          title={parsed.title}
                        >
                          <span className={statusCls}>{parsed.kind === "tool_use" ? "Tool" : "Result"}</span>
                          <span className="truncate text-[var(--vscode-foreground)]">{parsed.title}</span>
                        </button>
                        {open ? (
                          <div className="mt-1 grid gap-2 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">Output</div>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                                onClick={() => void copyToClipboard(parsed.detail || "")}
                              >
                                <Copy className="h-3.5 w-3.5" />
                                Copy
                              </button>
                            </div>
                            <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/10 p-2 text-[11px] text-[var(--vscode-foreground)]">
                              {parsed.detail || "(no output)"}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    );
                  }
                }

                const attached =
                  m.role === "user" && Array.isArray(meta?.attachedFiles) ? (meta.attachedFiles as any[]).map((p) => String(p ?? "")).filter(Boolean) : [];

                if (m.role === "user") {
                  return (
                    <div key={m.id} className="mb-2 flex justify-end px-2">
                      <div className="max-w-[70%] rounded-2xl bg-black/10 px-3 py-2 text-[13px] leading-5 text-[var(--vscode-foreground)]">
                        <div className="xcoding-markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                            {String(m.text ?? "")}
                          </ReactMarkdown>
                        </div>
                        {attached.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {attached.map((body) => {
                              const parsed = parseAtMentionBody(body);
                              const displayPath = parsed?.path ? parsed.path : String(body ?? "");
                              const range = parsed?.range ?? null;
                              const rangeLabel = range
                                ? range.startLine === range.endLine
                                  ? `#${range.startLine}`
                                  : `#${range.startLine}-${range.endLine}`
                                : "";
                              const parts = displayPath.split("/").filter(Boolean);
                              const name = parts[parts.length - 1] ?? displayPath;
                              const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
                              return (
                                <div
                                  key={body}
                                  className="flex max-w-full items-center gap-2 rounded-full border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2 py-1 text-[11px] text-[var(--vscode-foreground)]"
                                  title={`@${body}`}
                                >
                                  <span className="min-w-0 truncate">{name}</span>
                                  {rangeLabel ? <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">{rangeLabel}</span> : null}
                                  {dir ? <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">{dir}</span> : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                }

                if (m.role === "assistant") {
                  const thinking = typeof meta?.thinking === "string" ? String(meta.thinking) : "";
                  const body = String(m.text ?? "");
                  if (!body.trim() && !thinking.trim()) {
                    const isActiveThinking =
                      isTurnInProgress &&
                      storeRef.current.streaming.activeAssistantMessageId &&
                      String(storeRef.current.streaming.activeAssistantMessageId) === String(m.id);
                    if (!isActiveThinking) return null;
                    return (
                      <div key={m.id} className="my-1 px-2 py-1">
                        <div className="inline-flex items-center gap-2 text-[12px] text-[var(--vscode-descriptionForeground)]">
                          <span className="xcoding-codex-dots xcoding-codex-dots-spin xcoding-codex-title-blink" />
                          <span>Thinking…</span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={m.id} className="my-1 px-2 py-1">
                      <div className="text-[13px] leading-[1.095rem] text-[var(--vscode-foreground)]">
                        <div className="xcoding-markdown">
                          {thinking.trim() ? (
                            <details className="mb-2 rounded border border-[var(--vscode-panel-border)] bg-black/5 p-2">
                              <summary className="cursor-pointer text-[11px] text-[var(--vscode-descriptionForeground)]">Thinking</summary>
                              <pre className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--vscode-foreground)]">{thinking}</pre>
                            </details>
                          ) : null}
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                            {body}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={m.id} className="mb-2 px-2">
                    <div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2 text-[11px] text-[var(--vscode-foreground)]">
                      <div className="xcoding-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                          {String(m.text ?? "")}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {isDiffPanelOpen && diffSessionId ? (
            <div className="w-[min(520px,45vw)] min-w-[320px] border-l border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
              <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2 py-2">
                <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">Diff/Review</div>
                <div className="flex items-center gap-2">
                  <button
                    className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
                    onClick={openSelectedFile}
                    type="button"
                    disabled={!diffSelectedAbsPath || !projectRootPath}
                    title={diffSelectedAbsPath ? `Open ${toDisplayPath(diffSelectedAbsPath)}` : "Select a file"}
                  >
                    Open
                  </button>
                  <button
                    className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    onClick={() => void refreshDiffFiles()}
                    type="button"
                  >
                    Refresh
                  </button>
                  <button
                    className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                    onClick={() => setIsDiffPanelOpen(false)}
                    type="button"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="grid h-full min-h-0 gap-2 p-2">
                {diffFiles.length ? (
                  <div className="grid min-h-0 grid-cols-2 gap-2">
                    <div className="min-h-0 overflow-auto rounded border border-[var(--vscode-panel-border)] p-1">
                      <div className="p-1">
                        <input
                          className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[11px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                          placeholder="Filter files…"
                          value={diffQuery}
                          onChange={(e) => setDiffQuery(e.target.value)}
                        />
                        <div className="mt-1 text-[10px] text-[var(--vscode-descriptionForeground)]">
                          {visibleDiffFiles.length}/{diffFiles.length} files
                        </div>
                      </div>
                      {visibleDiffFiles.map((f) => {
                        const label = toDisplayPath(f.absPath);
                        const canOpen = Boolean(projectRootPath) && label !== f.absPath;
                        const stats = diffStats[f.absPath] ?? null;
                        return (
                          <button
                            key={f.absPath}
                            className={[
                              "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px]",
                              f.absPath === diffSelectedAbsPath
                                ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                                : "hover:bg-[var(--vscode-list-hoverBackground)]"
                            ].join(" ")}
                            onClick={() => void loadDiffForFile(f.absPath)}
                            onDoubleClick={() => {
                              if (!canOpen) return;
                              setDiffSelectedAbsPath(f.absPath);
                              window.dispatchEvent(new CustomEvent("xcoding:openFile", { detail: { relPath: label } }));
                            }}
                            type="button"
                            title={label}
                          >
                            <span className="min-w-0 flex-1 truncate">{label}</span>
                            {stats ? (
                              <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">
                                +{stats.added} -{stats.removed}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                    <div className="min-h-0 rounded border border-[var(--vscode-panel-border)] p-2">
                      {diffState.loading ? (
                        <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loading")}</div>
                      ) : diffState.error ? (
                        <div className="text-[11px] text-[var(--vscode-errorForeground)]">{diffState.error}</div>
                      ) : diffSelectedAbsPath ? (
                        <div className="flex h-full min-h-0 flex-col">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 truncate text-[11px] text-[var(--vscode-foreground)]" title={toDisplayPath(diffSelectedAbsPath)}>
                              {toDisplayPath(diffSelectedAbsPath)}
                            </div>
                            <button
                              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                              onClick={() => {
                                const ok = window.confirm("Revert this file to Claude backup version?");
                                if (!ok) return;
                                void window.xcoding.claude
                                  .revertFileFromBackup({ absPath: diffSelectedAbsPath, content: diffState.original })
                                  .then((res) => {
                                    if (!res?.ok) pushSystemMessage(`Revert failed: ${String(res?.reason ?? "unknown")}`);
                                  })
                                  .catch((e) => pushSystemMessage(`Revert failed: ${e instanceof Error ? e.message : String(e)}`));
                              }}
                              type="button"
                            >
                              Revert
                            </button>
                          </div>
                          <div className="min-h-0 flex-1">
                            <ClaudeFileDiffView
                              slot={slot}
                              sessionId={diffSessionId}
                              absPath={diffSelectedAbsPath}
                              loading={diffState.loading}
                              error={diffState.error}
                              original={diffState.original}
                              modified={diffState.modified}
                            />
                          </div>
                          {diffState.unifiedDiff ? (
                            <details className="mt-2 rounded border border-[var(--vscode-panel-border)] bg-black/5 p-2">
                              <summary className="cursor-pointer text-[11px] text-[var(--vscode-descriptionForeground)]">Patch</summary>
                              {diffState.unifiedTruncated ? (
                                <div className="mt-2 text-[10px] text-[var(--vscode-descriptionForeground)]">Patch truncated.</div>
                              ) : null}
                              <div className="mt-2 max-h-[35vh] overflow-auto rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
                                <DiffViewer diff={diffState.unifiedDiff} defaultViewMode="side-by-side" showFileList={false} showMetaLines={false} />
                              </div>
                            </details>
                          ) : null}
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
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-[var(--vscode-panel-border)] p-2">
        <div className="relative flex flex-col gap-2 rounded-2xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-input-background)] px-4 py-3 text-[var(--vscode-input-foreground)]">
          {attachedFiles.length ? (
            <div className="flex flex-wrap gap-2 px-1">
              {attachedFiles.map((body) => {
                const parsed = parseAtMentionBody(body);
                const displayPath = parsed?.path ? parsed.path : String(body ?? "");
                const range = parsed?.range ?? null;
                const rangeLabel = range ? (range.startLine === range.endLine ? `#${range.startLine}` : `#${range.startLine}-${range.endLine}`) : "";
                const parts = displayPath.split("/").filter(Boolean);
                const name = parts[parts.length - 1] ?? displayPath;
                const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
                return (
                  <div
                    key={body}
                    className="flex max-w-full items-center gap-2 rounded-full border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2 py-1 text-[11px] text-[var(--vscode-foreground)]"
                    title={`@${body}`}
                  >
                    <span className="min-w-0 truncate">{name}</span>
                    {rangeLabel ? <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">{rangeLabel}</span> : null}
                    {dir ? <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">{dir}</span> : null}
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                      title="Remove"
                      onClick={() => setAttachedFiles((prev) => prev.filter((p) => p !== body))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <textarea
            ref={inputRef}
            className="min-h-[72px] w-full resize-none bg-transparent px-2 py-1 text-[13px] text-[var(--vscode-input-foreground)] outline-none disabled:opacity-60"
            placeholder={t("ask")}
            value={input}
            disabled={!projectRootPath}
            onChange={(e) => {
              const next = e.target.value;
              setInput(next);
              const cursor = typeof e.target.selectionStart === "number" ? e.target.selectionStart : next.length;
              const slashToken = findSlashToken(next, cursor);
              if (slashToken) {
                setCommandMenuMode({ kind: "slashToken", start: slashToken.start, end: slashToken.end });
                setCommandFilter(slashToken.query);
                if (isFileMenuOpen) closeFileMenu();
              } else if (commandMenuMode?.kind === "slashToken") {
                closeCommandMenu();
              }

              const atToken = findAtToken(next, cursor);
              if (atToken) {
                setIsPlusMenuOpen(false);
                closeCommandMenu();
                closeModelMenu();
                setFileMenuMode({ kind: "atToken", start: atToken.start, end: atToken.end });
              } else if (fileMenuMode?.kind === "atToken") {
                closeFileMenu();
              }
            }}
            onKeyDown={(e) => {
              if ((isCommandMenuOpen && suppressCommandFilter) || isFileMenuOpen || isModelMenuOpen) return;
              if (e.key !== "Enter") return;
              if ((e.nativeEvent as any)?.isComposing || (e as any).isComposing) return;
              if (e.shiftKey) return;
              // While streaming, Enter should only add a newline (no send / no stop).
              if (isTurnInProgress) return;
              if (!input.trim() && attachedFiles.length === 0) return;
              e.preventDefault();
              void send();
            }}
          />

          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1">
              <button
                ref={plusTriggerRef}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                title={t("attach")}
                onClick={() => {
                  closeCommandMenu();
                  closeFileMenu();
                  closeModelMenu();
                  setIsPlusMenuOpen((v) => !v);
                }}
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                ref={commandTriggerRef}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                type="button"
                title="/"
                onClick={() => {
                  setIsPlusMenuOpen(false);
                  closeFileMenu();
                  closeModelMenu();
                  setCommandMenuMode((prev) => (prev ? null : { kind: "button" }));
                  setCommandFilter("");
                }}
              >
                <Slash className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-full bg-[var(--vscode-button-background)] p-2 text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
                onClick={() => (isTurnInProgress ? void stop() : void send())}
                type="button"
                title={isTurnInProgress ? t("stop") : t("send")}
                disabled={!projectRootPath || (isTurnInProgress ? false : !input.trim() && attachedFiles.length === 0)}
              >
                {isTurnInProgress ? <Square className="h-4 w-4" /> : "↑"}
              </button>
            </div>
          </div>

          {isPlusMenuOpen ? (
            <div
              ref={plusMenuRef}
              className="absolute bottom-12 left-3 z-50 w-[260px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-xl"
            >
              <button
                type="button"
                className={[
                  "block w-full px-3 py-2 text-left text-[12px]",
                  activeEditorContext?.relPath ? "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]" : "opacity-50"
                ].join(" ")}
                onClick={() => {
                  setIsPlusMenuOpen(false);
                  mentionActiveSelection();
                }}
                disabled={!activeEditorContext?.relPath}
              >
                Mention selection…
                <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                  {activeEditorContext?.relPath ? `Insert @${activeEditorContext.relPath}${activeEditorContext.range ? "#…" : ""}` : "Select a file in the editor first"}
                </div>
              </button>
              <button
                type="button"
                className={[
                  "block w-full px-3 py-2 text-left text-[12px]",
                  activeEditorContext?.range ? "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]" : "opacity-50"
                ].join(" ")}
                onClick={() => {
                  setIsPlusMenuOpen(false);
                  attachActiveSelection();
                }}
                disabled={!activeEditorContext?.range}
              >
                Attach selection…
                <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                  {activeEditorContext?.range ? "Attach current editor selection as hidden context" : "Select some text in the editor first"}
                </div>
              </button>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                onClick={() => {
                  setIsPlusMenuOpen(false);
                  openFilePicker("attach");
                }}
              >
                Attach file…
                <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">Attach a project file as hidden context</div>
              </button>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                onClick={() => {
                  setIsPlusMenuOpen(false);
                  openFilePicker("mention");
                }}
              >
                Mention file…
                <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">Insert an @file mention into the message</div>
              </button>
            </div>
          ) : null}

          {isFileMenuOpen ? (
            <div
              ref={fileMenuRef}
              className="absolute bottom-12 left-3 z-50 w-[320px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-xl"
            >
              <div style={{ height: 4 }} />
              <div className="max-h-[40vh] overflow-auto py-1">
                {fileMenuLoading ? (
                  <div className="px-3 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">Searching…</div>
                ) : !fileSearchQuery.trim() ? (
                  <div className="px-3 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">Type to search files…</div>
                ) : fileMenuResults.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">No matching files</div>
                ) : (
                  fileMenuResults.map((f, idx) => {
                    const parts = String(f.relativePath ?? "").split("/").filter(Boolean);
                    const name = String(f.name ?? parts[parts.length - 1] ?? f.relativePath);
                    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
                    const active = idx === fileMenuSelectedIndex;
                    return (
                      <button
                        key={`${f.relativePath}:${idx}`}
                        type="button"
                        className={[
                          "block w-full px-3 py-2 text-left text-[12px]",
                          active
                            ? "bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-foreground)]"
                            : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                        ].join(" ")}
                        onMouseEnter={() => setFileMenuSelectedIndex(idx)}
                        onClick={() => applyPickedFile(f.relativePath, false)}
                        title={f.relativePath}
                        ref={(el) => {
                          if (!el) return;
                          if (fileMenuScrollToIndex == null) return;
                          if (fileMenuScrollToIndex !== idx) return;
                          try {
                            el.scrollIntoView({ behavior: "instant" as any, block: "nearest" });
                          } catch {
                            // ignore
                          }
                        }}
                      >
                        <div className="min-w-0">
                          <div className="min-w-0 truncate">{name}</div>
                          {dir ? <div className="min-w-0 truncate text-[10px] text-[var(--vscode-descriptionForeground)]">{dir}</div> : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}

          {isModelMenuOpen ? (
            <div
              ref={modelMenuRef}
              className="absolute bottom-12 left-3 z-50 w-[320px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-xl"
            >
              <div style={{ height: 4 }} />
              <div className="max-h-[40vh] overflow-auto py-1">
                {modelMenuModels.map((m, idx) => {
                  const active = idx === modelMenuSelectedIndex;
                  const isCurrent = m.value === currentModel;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      className={[
                        "block w-full px-3 py-2 text-left text-[12px]",
                        active
                          ? "bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-foreground)]"
                          : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                      ].join(" ")}
                      onMouseEnter={() => setModelMenuSelectedIndex(idx)}
                      onClick={() => void selectModel(m.value, false)}
                      title={m.description}
                      ref={(el) => {
                        if (!el) return;
                        if (modelMenuScrollToIndex == null) return;
                        if (modelMenuScrollToIndex !== idx) return;
                        try {
                          el.scrollIntoView({ behavior: "instant" as any, block: "nearest" });
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="min-w-0 truncate">{m.displayName || m.value}</div>
                          {m.description ? <div className="min-w-0 truncate text-[10px] text-[var(--vscode-descriptionForeground)]">{m.description}</div> : null}
                        </div>
                        <div className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">{isCurrent ? "Current" : ""}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {isCommandMenuOpen ? (
            <div
              ref={commandMenuRef}
              className="absolute bottom-12 left-3 z-50 w-[260px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-xl"
            >
              {!suppressCommandFilter ? (
                <div className="border-b border-[var(--vscode-panel-border)] p-2">
                  <input
                    className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                    placeholder="Filter actions…"
                    value={commandFilter}
                    onChange={(e) => setCommandFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (["Escape", "ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) handleCommandMenuKeyDown(e);
                    }}
                    autoFocus
                  />
                </div>
              ) : (
                <div style={{ height: 4 }} />
              )}

              <div className="max-h-[40vh] overflow-auto py-1">
                {Object.keys(commandMenuSections.filtered).length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">No matching commands</div>
                ) : (
                  Object.entries(commandMenuSections.filtered).map(([section, cmds], sectionIdx) => (
                    <div key={section}>
                      {sectionIdx > 0 ? <div className="my-1 h-px bg-[var(--vscode-panel-border)]" /> : null}
                      <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
                        {section}
                      </div>
                      {cmds.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={[
                            "block w-full px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)]",
                            c.id === commandMenuActiveId ? "bg-[var(--vscode-toolbar-hoverBackground)]" : "hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                          ].join(" ")}
                          title={c.description}
                          onMouseEnter={() => setCommandMenuActiveId(c.id)}
                          onClick={() => {
                            c.run({ viaTab: false });
                            if (!c.keepMenuOpen) closeCommandMenu();
                          }}
                          ref={(el) => {
                            if (!el) return;
                            if (!commandMenuScrollToId) return;
                            if (commandMenuScrollToId !== c.id) return;
                            try {
                              el.scrollIntoView({ behavior: "instant" as any, block: "nearest" });
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 truncate">{c.label}</div>
                            {c.trailingComponent ? <div className="shrink-0">{c.trailingComponent}</div> : null}
                          </div>
                          {c.description ? <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">{c.description}</div> : null}
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 px-1">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <select
            className="rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[11px] text-[var(--vscode-input-foreground)] ring-1 ring-[var(--vscode-input-border)] disabled:opacity-50"
            value={mode}
            onChange={(e) => void setModeAndPersist(e.target.value as ClaudePermissionMode)}
            disabled={!projectRootPath}
            title="Mode"
          >
            <option value="default">{modeLabel("default")}</option>
            <option value="acceptEdits">{modeLabel("acceptEdits")}</option>
            <option value="plan">{modeLabel("plan")}</option>
            <option value="bypassPermissions">{modeLabel("bypassPermissions")}</option>
          </select>

          <select
            className="rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[11px] text-[var(--vscode-input-foreground)] ring-1 ring-[var(--vscode-input-border)] disabled:opacity-50"
            value={currentModel}
            onChange={(e) => void selectModel(e.target.value, false)}
            disabled={!projectRootPath}
            title="Model"
          >
            {modelSelectOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            className={[
              "inline-flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50",
              thinkingEnabled
                ? "bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-foreground)]"
                : "text-[var(--vscode-descriptionForeground)]"
            ].join(" ")}
            type="button"
            title="Thinking"
            onClick={toggleThinking}
            disabled={!projectRootPath}
          >
            Thinking
            <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">{thinkingEnabled ? "On" : "Off"}</span>
          </button>
        </div>
        <div />
      </div>
    </div>
  );
}
