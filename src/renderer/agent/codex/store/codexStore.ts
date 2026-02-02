import { extractPromptRequest } from "../prompt";
import type { Store, ThreadView, TurnView } from "../panel/types";

export function createCodexStore(): Store {
  return {
    status: { state: "idle" },
    threads: [],
    threadById: {},
    approvalsByItemId: {},
    lastStderr: "",
    tokenUsageByThreadId: {},
    rateLimits: null
  };
}

export function normalizeTurn(turn: any): TurnView {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return {
    id: String(turn?.id ?? ""),
    status: typeof turn?.status === "string" ? turn.status : undefined,
    items,
    error: turn?.error
  };
}

export function normalizeThread(thread: any): ThreadView {
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
    source: typeof thread?.source === "undefined" ? undefined : thread.source,
    createdAt: typeof thread?.createdAt === "number" ? thread.createdAt : undefined,
    path: typeof thread?.path === "string" ? thread.path : undefined,
    cwd: typeof thread?.cwd === "string" ? thread.cwd : undefined,
    turns,
    latestDiff
  };
}
