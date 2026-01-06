import type { MutableRefObject } from "react";
import { extractPromptRequest } from "../prompt";
import { normalizeThread, normalizeTurn } from "./codexStore";
import type { Store, TurnView } from "../panel/types";

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export function createCodexApprovalHandler({
  storeRef,
  bump
}: {
  storeRef: MutableRefObject<Store>;
  bump: () => void;
}) {
  return function onApprovalDecision(itemId: string, decision: ApprovalDecision) {
    const req = storeRef.current.approvalsByItemId[itemId];
    if (!req) return;
    delete storeRef.current.approvalsByItemId[itemId];
    if ((decision === "accept" || decision === "acceptForSession") && req.method === "item/fileChange/requestApproval") {
      const threadId = String(req.params?.threadId ?? "");
      const turnId = String(req.params?.turnId ?? "");
      const thread = threadId ? storeRef.current.threadById[threadId] : null;
      const turn = thread && turnId ? thread.turns.find((t) => t.id === turnId) : null;
      if (turn) turn.snapshot = { status: "available" };
    }
    bump();
    void window.xcoding.codex.respond({ id: req.rpcId, result: { decision } });
  };
}

export function createCodexNotificationHandler({
  storeRef,
  bump,
  bumpThreads,
  activeThreadIdRef
}: {
  storeRef: MutableRefObject<Store>;
  bump: () => void;
  bumpThreads: () => void;
  activeThreadIdRef: MutableRefObject<string | null>;
}) {
  return function handleNotification(method: string, params: any) {
    const store = storeRef.current;
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
          const changes: Array<{ path: string; kind: string; diff: string }> = [];
          const lines = patchText.split(/\r?\n/);
          let current: { path: string; kind: string; lines: string[] } | null = null;

          const flush = () => {
            if (!current) return;
            const diff = current.lines.join("\n").trim();
            if (diff) changes.push({ path: current.path, kind: current.kind, diff });
            current = null;
          };

          for (const line of lines) {
            const m = line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
            if (m && m[2]) {
              flush();
              current = { path: String(m[2]).trim(), kind: String(m[1]).replaceAll(" ", "").toLowerCase(), lines: [line] };
              continue;
            }
            if (!current) continue;
            current.lines.push(line);
          }
          flush();

          item.changes = changes.length ? changes : [{ path: "patch", kind: "patch", diff: patchText }];
        }
      }
    };

    const upsertToolByCallId = (threadId: string, turnId: string, callId: string, patch: (it: any) => void) => {
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === callId);
      if (!item) item = { type: "localToolCall", id: callId, name: "", arguments: "", input: "", output: "", status: "inProgress" };
      patch(item);
      normalizeToolItemType(item);
      upsertItem(threadId, turnId, item);
    };

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
      if (idx >= 0) existing.turns = [...existing.turns.slice(0, idx), turnView, ...existing.turns.slice(idx + 1)];
      else existing.turns = [...(existing.turns ?? []), turnView];
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);

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

    if (method.startsWith("item/") && params?.item?.id && typeof params?.threadId === "string" && typeof params?.turnId === "string") {
      const threadId = resolveThreadId(params.threadId);
      if (!threadId) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) item = { id: itemId, type: "agentMessage", status: "inProgress", text: "" };
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) item = { id: itemId, type: "commandExecution", status: "inProgress", aggregatedOutput: "" };
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      const items = Array.isArray(turn.items) ? turn.items : [];
      let item = items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) item = { id: itemId, type: "reasoning", status: "inProgress", content: [] as string[] };
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
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      let item = turn.items.find((it) => String(it?.id ?? "") === itemId);
      if (!item) {
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
      upsertItem(threadId, turnId, item);
      bump();
      return;
    }

    if (method === "item/toolCall/started" || method === "item/toolCall/updated" || method === "item/toolCall/completed") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const callId = String(params?.callId ?? params?.id ?? "");
      if (!threadId || !callId) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turnId = String(params?.turnId ?? "") || pickActiveTurnId(threadId);
      upsertToolByCallId(threadId, turnId, callId, (it) => {
        it.name = String(params?.name ?? it.name ?? "");
        if (params?.arguments != null) it.arguments = String(params.arguments);
        if (params?.input != null) it.input = String(params.input);
        if (params?.output != null) it.output = String(params.output);
        if (params?.status != null) it.status = String(params.status);
      });
      bump();
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const itemId = String(params?.itemId ?? "");
      const rpcId = Number(params?.rpcId ?? params?.id ?? 0);
      if (!threadId || !turnId || !itemId || !rpcId) return;
      store.approvalsByItemId[itemId] = { rpcId, method, params };
      bump();
      return;
    }

    if (method === "turn/planUpdated") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const plan = params?.plan;
      if (!threadId || !turnId || !plan) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      turn.plan = plan;
      bump();
      return;
    }

    if (method === "turn/diffUpdated") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const diff = typeof params?.diff === "string" ? params.diff : "";
      if (!threadId || !turnId || !diff) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      (turn as TurnView).diff = diff;
      bump();
      return;
    }

    if (method === "thread/previewUpdated") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const preview = typeof params?.preview === "string" ? params.preview : "";
      if (!threadId || !preview) return;
      const thread = ensureThread(threadId);
      thread.preview = preview;
      if (!thread.title) thread.title = extractPromptRequest(preview) || preview;
      store.threads = store.threads.map((t) => (t.id === threadId ? { ...t, preview, title: thread.title } : t));
      bumpThreads();
      bump();
      return;
    }

    if (method === "turn/error") {
      const threadId = resolveThreadId(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const error = params?.error ?? null;
      if (!threadId || !turnId || !error) return;
      if (!store.threadById[threadId] && threadId !== activeThreadIdRef.current) return;
      const turn = ensureTurn(threadId, turnId);
      (turn as TurnView).error = error;
      bump();
      return;
    }
  };
}
