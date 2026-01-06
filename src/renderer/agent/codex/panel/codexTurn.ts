import type { MutableRefObject } from "react";
import { renderComposerPrompt, type IdeContext } from "../prompt";
import { normalizeThread, normalizeTurn } from "../store/codexStore";
import {
  contentKey,
  makeTurnOverrides,
  type CodexMode,
  type ComposerAttachment,
  type ReasoningEffort,
  type Store,
  type ThreadView,
  type TurnView,
  type WorkspaceWritePolicy
} from "./types";

export function createCodexTurnActions({
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
  setActiveThreadId
}: {
  storeRef: MutableRefObject<Store>;
  bump: () => void;
  setIsBusy: (v: boolean) => void;
  setIsHistoryOpen: (v: boolean) => void;
  setScrollToBottomNonce: (v: number | ((prev: number) => number)) => void;
  setInput: (v: string) => void;
  setAttachments: (v: ComposerAttachment[]) => void;
  setIsPlusMenuOpen: (v: boolean) => void;
  setIsSlashMenuOpen: (v: boolean) => void;
  activeThreadIdRef: MutableRefObject<string | null>;
  mode: CodexMode;
  model: string;
  effort: ReasoningEffort;
  autoContext: boolean;
  configSnapshot: { model?: string; effort?: ReasoningEffort; workspaceWrite?: WorkspaceWritePolicy } | null;
  ideContextRef: MutableRefObject<IdeContext | null>;
  attachments: ComposerAttachment[];
  projectRootPath?: string;
  activeThread: ThreadView | null;
  setActiveThreadId: (id: string | null) => void;
}) {
  async function sendTurn(input: string) {
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
      let threadId = activeThreadIdRef.current;
      if (!threadId) {
        const res = await window.xcoding.codex.threadStart({ cwd: projectRootPath });
        if (!res.ok) throw new Error(res.reason || "thread_start_failed");
        const thread = res.result?.thread;
        if (!thread?.id) throw new Error("thread_missing");
        const view = normalizeThread(thread);
        storeRef.current.threadById[view.id] = view;
        storeRef.current.threads = [view, ...storeRef.current.threads.filter((t) => t.id !== view.id)];
        threadId = view.id;
        setActiveThreadId(threadId);
      }
      activeThreadIdRef.current = threadId;

      const effectiveCwd = (activeThread as any)?.cwd || projectRootPath;
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

      const store = storeRef.current;
      const thread = store.threadById[threadId];
      if (thread) {
        const rawTurn = (res.result as any)?.turn;
        const rawTurnId = String((res.result as any)?.turnId ?? "");
        const turnFromResponse = rawTurn?.id ? normalizeTurn(rawTurn) : rawTurnId ? ({ id: rawTurnId, status: "inProgress", items: [] } satisfies TurnView) : null;
        if (turnFromResponse && !thread.turns.some((t) => t.id === turnFromResponse.id)) thread.turns = [...(thread.turns ?? []), turnFromResponse];
        const turnId = turnFromResponse?.id || rawTurnId;
        if (turnId) {
          const turnView = thread.turns.find((t) => t.id === turnId);
          if (turnView) {
            const hasUserItem =
              Array.isArray(turnView.items) &&
              turnView.items.some((it: any) => String((it as any)?.type ?? "") === "userMessage" || String((it as any)?.role ?? "") === "user");
            if (!hasUserItem) {
              const content = inputBlocks;
              turnView.items = [
                ...(turnView.items ?? []),
                { id: `local-user-${Date.now()}`, type: "userMessage", content, __optimistic: true, __contentKey: contentKey(content) }
              ];
            }
          }
        }
        bump();
      }

      setScrollToBottomNonce((v) => v + 1);
      setInput("");
      setAttachments([]);
      setIsPlusMenuOpen(false);
      setIsSlashMenuOpen(false);
    } finally {
      setIsBusy(false);
    }
  }

  async function stopTurn(activeThread: ThreadView | null) {
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

  return { sendTurn, stopTurn };
}
