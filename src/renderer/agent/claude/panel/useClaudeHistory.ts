import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useMemo, useState } from "react";

import type { ClaudeStore, ClaudeUiMessage } from "../store/claudeStore";
import type { ClaudePermissionMode } from "./types";
import { extractTrailingAtMentionBodies } from "./atMentions";
import { isUnhelpfulHistoryMarkerLine } from "./panelUtils";

type ClaudeSessionReadResult = Awaited<ReturnType<Window["xcoding"]["claude"]["sessionRead"]>>;

type Params = {
  slot: number;
  projectRootPath?: string;
  mode: ClaudePermissionMode;
  isDev: boolean;
  storeRef: MutableRefObject<ClaudeStore>;
  interruptedDraftBySessionIdRef: MutableRefObject<Map<string, ClaudeUiMessage[]>>;
  bump: () => void;
  pushSystemMessage: (text: string) => void;
  setIsTurnInProgress: Dispatch<SetStateAction<boolean>>;
  setDiffSessionId: Dispatch<SetStateAction<string | null>>;
  resetDiffListState: () => void;
};

export function useClaudeHistory({
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
}: Params) {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySessions, setHistorySessions] = useState<Array<{ sessionId: string; updatedAtMs: number; preview?: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refreshHistory = useCallback(async () => {
    if (!projectRootPath) return;
    setHistoryLoading(true);
    try {
      const res = await window.xcoding.claude.historyList({ projectRootPath });
      if (res?.ok && Array.isArray(res.sessions)) {
        const rows = res.sessions
          .map((s: any) => ({
            sessionId: String(s.sessionId ?? ""),
            updatedAtMs: Number(s.updatedAtMs ?? 0),
            preview: typeof s.preview === "string" ? s.preview : undefined
          }))
          .filter((s: any) => s.sessionId);
        rows.sort((a: any, b: any) => Number(b.updatedAtMs) - Number(a.updatedAtMs));
        setHistorySessions(rows);
      } else {
        pushSystemMessage(`Failed to load history: ${String(res?.reason ?? "unknown")}`);
        setHistorySessions([]);
      }
    } catch (e) {
      pushSystemMessage(`Failed to load history: ${e instanceof Error ? e.message : String(e)}`);
      setHistorySessions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [projectRootPath, pushSystemMessage]);

  const visibleHistorySessions = useMemo(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return historySessions;
    return historySessions.filter((s) => {
      if (s.sessionId.toLowerCase().includes(q)) return true;
      const p = String(s.preview ?? "").toLowerCase();
      return p.includes(q);
    });
  }, [historyQuery, historySessions]);

  const loadHistorySession = useCallback(
    async (sessionId: string) => {
      if (!projectRootPath) return;
      const targetSessionId = String(sessionId ?? "").trim();
      if (!targetSessionId) return;
      setHistoryLoading(true);
      try {
        const cached = interruptedDraftBySessionIdRef.current.get(targetSessionId);
        if (cached && cached.length) {
          const cachedAssistantChars = cached
            .filter((m) => m.role === "assistant" && typeof m.text === "string")
            .reduce((sum, m) => sum + String(m.text).length, 0);
          if (cachedAssistantChars > 0) {
            storeRef.current.messages = cached.map((m) => ({
              ...m,
              meta: { ...(m.meta as any), restoredFromInterruptedDraft: true }
            }));
            setDiffSessionId(targetSessionId);
            resetDiffListState();
            setIsTurnInProgress(false);
            bump();
            setIsHistoryOpen(false);
            return;
          }
        }

        // Read history first so the UI isn't blocked by resume/startup.
        const res = await Promise.race<ClaudeSessionReadResult>([
          window.xcoding.claude.sessionRead({ projectRootPath, sessionId: targetSessionId }),
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
          if (turn.user?.text) {
            const rawText = String(turn.user.text);
            const decoded = extractTrailingAtMentionBodies(rawText);
            if (isUnhelpfulHistoryMarkerLine(decoded.visibleText)) {
              // Do not render CLI status marker as a standalone "message" row.
              continue;
            }
            const meta: any = { uuid: turn.user?.uuid };
            if (decoded.bodies.length) meta.attachedFiles = decoded.bodies;
            storeRef.current.messages.push({ id: `hu-${turn.id}`, role: "user", text: decoded.visibleText, meta });
            added += 1;
          }
          if (turn.assistant?.text)
            storeRef.current.messages.push({
              id: `ha-${turn.id}`,
              role: "assistant",
              text: String(turn.assistant.text),
              meta: { uuid: turn.assistant?.uuid, assistantMessageId: turn.assistant?.assistantMessageId }
            });
          if (turn.assistant?.text) added += 1;
        }
        if (cached && cached.length) {
          // Prefer the cached draft if it contains more assistant output than what is persisted in jsonl.
          const cachedAssistantChars = cached
            .filter((m) => m.role === "assistant" && typeof m.text === "string")
            .reduce((sum, m) => sum + String(m.text).length, 0);
          const loadedAssistantChars = storeRef.current.messages
            .filter((m) => m.role === "assistant" && typeof m.text === "string")
            .reduce((sum, m) => sum + String(m.text).length, 0);
          if (cachedAssistantChars > loadedAssistantChars) {
            storeRef.current.messages = cached.map((m) => ({
              ...m,
              meta: { ...(m.meta as any), restoredFromInterruptedDraft: true }
            }));
          }
        }
        if (isDev) {
          storeRef.current.messages.unshift({
            id: `hist-${Date.now()}`,
            role: "system",
            text: `Loaded history (${added} messages)`
          });
        }
        setDiffSessionId(targetSessionId);
        resetDiffListState();
        setIsTurnInProgress(false);
        bump();
        setIsHistoryOpen(false);
      } catch (e) {
        pushSystemMessage(`Failed to load session: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setHistoryLoading(false);
      }
    },
    [bump, interruptedDraftBySessionIdRef, isDev, projectRootPath, pushSystemMessage, resetDiffListState, setDiffSessionId, setIsTurnInProgress, storeRef]
  );

  const forkHistorySession = useCallback(
    async (baseSessionId: string) => {
      if (!projectRootPath) return;
      setHistoryLoading(true);
      try {
        const res = await window.xcoding.claude.forkSession({ slot, projectRootPath, sessionId: baseSessionId, permissionMode: mode });
        if (res?.ok && typeof res.sessionId === "string" && res.sessionId) {
          await loadHistorySession(String(res.sessionId));
        } else {
          pushSystemMessage(`Failed to fork session: ${String(res?.reason ?? "unknown")}`);
        }
      } catch (e) {
        pushSystemMessage(`Failed to fork session: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setHistoryLoading(false);
      }
    },
    [loadHistorySession, mode, projectRootPath, pushSystemMessage, slot]
  );

  return {
    isHistoryOpen,
    setIsHistoryOpen,
    historyQuery,
    setHistoryQuery,
    historySessions,
    historyLoading,
    visibleHistorySessions,
    refreshHistory,
    loadHistorySession,
    forkHistorySession
  };
}

