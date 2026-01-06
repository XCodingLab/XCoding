import type { MutableRefObject } from "react";
import { extractPromptRequest } from "../prompt";
import { normalizeThread } from "../store/codexStore";
import type { Store, ThreadSummary, ThreadView, TurnView } from "./types";

export function createCodexThreadsActions({
  storeRef,
  bump,
  bumpThreads,
  setIsBusy,
  setIsThreadsLoading,
  setLoadingThreadId,
  setIsHistoryOpen,
  setActiveThreadId,
  hydratedSessionThreadIdsRef
}: {
  storeRef: MutableRefObject<Store>;
  bump: () => void;
  bumpThreads: () => void;
  setIsBusy: (v: boolean) => void;
  setIsThreadsLoading: (v: boolean) => void;
  setLoadingThreadId: (v: string | null | ((prev: string | null) => string | null)) => void;
  setIsHistoryOpen: (v: boolean) => void;
  setActiveThreadId: (v: string | null) => void;
  hydratedSessionThreadIdsRef: MutableRefObject<Set<string>>;
}) {
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
      bumpThreads();
      bump();
    } finally {
      setIsBusy(false);
    }
  }

  const hydrateFromSession = async (t: ThreadView) => {
    const sessionPath = typeof (t as any)?.path === "string" ? String((t as any).path) : "";
    if (!sessionPath) return;
    if (hydratedSessionThreadIdsRef.current.has(t.id)) return;
    try {
      const res = await window.xcoding.codex.sessionRead({ path: sessionPath });
      if (!res.ok) return;
      hydratedSessionThreadIdsRef.current.add(t.id);
      const sessionTurns = Array.isArray(res.result?.turns) ? (res.result?.turns as any[]) : [];
      if (!sessionTurns.length) return;
      const thread = storeRef.current.threadById[t.id];
      if (!thread) return;

      const normalizeText = (s: string) =>
        String(s ?? "")
          .replace(/\r\n/g, "\n")
          .replace(/\s+/g, " ")
          .trim();

      const userSignatureForTurn = (turn: any) => {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        const user = items.find((it: any) => String(it?.type ?? "") === "userMessage") ?? null;
        const blocks = Array.isArray(user?.content) ? user.content : [];
        const txt = extractPromptRequest(
          blocks
            .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
            .filter(Boolean)
            .join("\n")
        );
        return normalizeText(txt).slice(0, 160);
      };

      const signatureForTurn = (turn: any) => {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        const agent = items.find((it: any) => String(it?.type ?? "") === "agentMessage") ?? null;
        const userText = userSignatureForTurn(turn);
        const agentText = normalizeText(String(agent?.text ?? "")).slice(0, 160);
        return `${userText}|||${agentText}`;
      };

      const candidatesBySig = new Map<string, TurnView>();
      for (const turn of thread.turns) {
        try {
          candidatesBySig.set(signatureForTurn(turn), turn);
        } catch {
          // ignore
        }
      }

      let didMutate = false;
      for (const st of sessionTurns) {
        const stId = String(st?.id ?? "");
        const target =
          (stId ? (thread.turns.find((x) => x.id === stId) ?? null) : null) ??
          (() => {
            try {
              return candidatesBySig.get(signatureForTurn(st)) ?? null;
            } catch {
              return null;
            }
          })() ??
          (() => {
            try {
              const userSig = userSignatureForTurn(st);
              if (!userSig) return null;
              return thread.turns.find((x) => userSignatureForTurn(x) === userSig) ?? null;
            } catch {
              return null;
            }
          })();
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
        didMutate = true;
      }

      if (didMutate) thread.turns = [...thread.turns];
      bump();
    } catch {
      // ignore
    }
  };

  async function openThread(threadId: string) {
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

  return { refreshThreads, openThread, archiveThread };
}

