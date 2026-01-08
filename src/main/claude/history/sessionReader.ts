import fs from "node:fs/promises";
import path from "node:path";
import { claudeProjectDir } from "./claudeProjectKey";

export type ClaudeHistoryItem =
  | { type: "user"; uuid: string; timestamp?: string; text: string }
  | { type: "assistant"; uuid: string; timestamp?: string; text: string; rawContent?: any[]; assistantMessageId?: string }
  | { type: "file-history-snapshot"; messageId: string; timestamp?: string; trackedFileBackups: Record<string, any> }
  | { type: "other"; raw: any };

export type ClaudeHistoryTurn = {
  id: string;
  user?: ClaudeHistoryItem & { type: "user" };
  assistant?: ClaudeHistoryItem & { type: "assistant" };
  snapshots: Array<ClaudeHistoryItem & { type: "file-history-snapshot" }>;
  toolEvents: Array<
    | { kind: "tool_use"; toolUseId?: string; name: string; input: any }
    | { kind: "tool_result"; toolUseId?: string; content: string; isError?: boolean }
  >;
};

export type ClaudeHistoryThread = {
  sessionId: string;
  projectRootPath: string;
  turns: ClaudeHistoryTurn[];
  debug?: { sourcePath: string };
};

function extractTextFromMessageContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .join("");
  }
  return "";
}

function extractToolUsesFromMessageContent(content: any): Array<{ toolUseId?: string; name: string; input: any }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId?: string; name: string; input: any }> = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type !== "tool_use") continue;
    out.push({ toolUseId: typeof b.id === "string" ? b.id : undefined, name: String(b.name ?? "tool"), input: b.input ?? {} });
  }
  return out;
}

function extractToolResultsFromMessageContent(content: any): Array<{ toolUseId?: string; content: string; isError?: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId?: string; content: string; isError?: boolean }> = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type !== "tool_result") continue;
    out.push({
      toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? null, null, 2),
      isError: typeof b.is_error === "boolean" ? b.is_error : undefined
    });
  }
  return out;
}

export async function readClaudeSession({
  projectRootPath,
  sessionId
}: {
  projectRootPath: string;
  sessionId: string;
}): Promise<ClaudeHistoryThread> {
  const abs = path.join(claudeProjectDir(projectRootPath), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed_to_read_session_file: ${abs}: ${msg}`);
  }

  const turns: ClaudeHistoryTurn[] = [];
  let pendingSnapshots: ClaudeHistoryTurn["snapshots"] = [];

  for (const line of raw.split("\n")) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const t = String(obj?.type ?? "");
    if (t === "file-history-snapshot") {
      const snap = obj?.snapshot ?? {};
      const backups = (snap?.trackedFileBackups && typeof snap.trackedFileBackups === "object") ? snap.trackedFileBackups : {};
      pendingSnapshots.push({
        type: "file-history-snapshot",
        messageId: String(obj?.messageId ?? snap?.messageId ?? ""),
        timestamp: typeof snap?.timestamp === "string" ? snap.timestamp : undefined,
        trackedFileBackups: backups
      });
      continue;
    }

    if (t === "user") {
      const msg = obj?.message ?? {};
      const content = msg?.content;
      const toolResults = extractToolResultsFromMessageContent(content);
      const text = extractTextFromMessageContent(content);
      // If this "user" message is a tool_result carrier, attach it to the latest turn.
      if (!text && toolResults.length && turns.length) {
        const last = turns[turns.length - 1];
        for (const tr of toolResults) last.toolEvents.push({ kind: "tool_result", toolUseId: tr.toolUseId, content: tr.content, isError: tr.isError });
        continue;
      }

      const turnId = String(obj?.uuid ?? `u-${turns.length}`);
      const nextTurn: ClaudeHistoryTurn = {
        id: turnId,
        user: { type: "user", uuid: turnId, timestamp: typeof obj?.timestamp === "string" ? obj.timestamp : undefined, text },
        assistant: undefined,
        snapshots: pendingSnapshots,
        toolEvents: []
      };
      for (const tr of toolResults) nextTurn.toolEvents.push({ kind: "tool_result", toolUseId: tr.toolUseId, content: tr.content, isError: tr.isError });
      turns.push(nextTurn);
      pendingSnapshots = [];
      continue;
    }

    if (t === "assistant") {
      const msg = obj?.message ?? {};
      const content = msg?.content;
      const toolUses = extractToolUsesFromMessageContent(content);
      const text = extractTextFromMessageContent(content);
      const assistantMessageId = typeof msg?.id === "string" ? String(msg.id) : undefined;
      const uuid = String(obj?.uuid ?? `a-${turns.length}`);
      const last = turns[turns.length - 1];
      if (last) {
        for (const tu of toolUses) last.toolEvents.push({ kind: "tool_use", toolUseId: tu.toolUseId, name: tu.name, input: tu.input });
      }

      // Pure tool_use messages (no text) should not create/overwrite assistant text.
      if (!text && toolUses.length) continue;

      if (last && !last.assistant) {
        last.assistant = {
          type: "assistant",
          uuid,
          timestamp: typeof obj?.timestamp === "string" ? obj.timestamp : undefined,
          text,
          rawContent: Array.isArray(content) ? content : undefined,
          assistantMessageId
        };
      } else {
        turns.push({
          id: uuid,
          user: undefined,
          assistant: { type: "assistant", uuid, timestamp: obj?.timestamp, text, assistantMessageId },
          snapshots: pendingSnapshots,
          toolEvents: []
        });
        pendingSnapshots = [];
      }
      continue;
    }
  }

  return { sessionId, projectRootPath, turns, debug: { sourcePath: abs } };
}
