import fs from "node:fs/promises";
import path from "node:path";
import { claudeProjectDir } from "./claudeProjectKey";

export type ClaudeSessionSummary = {
  sessionId: string;
  fileName: string;
  updatedAtMs: number;
  preview?: string;
};

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function clampOneLinePreview(text: string, maxLen: number) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!raw) return "";
  const firstLine = raw.split("\n").map((v) => v.trim()).find(Boolean) ?? "";
  if (!firstLine) return "";
  return firstLine.length > maxLen ? `${firstLine.slice(0, Math.max(0, maxLen - 1))}…` : firstLine;
}

function extractMessageTextFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      return "";
    })
    .join("");
}

function isUnhelpfulPreviewLine(text: string) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  // Claude Code can append synthetic status lines near the end of a session; these make the session list misleading.
  if (t === "no response requested.") return true;
  if (t === "[request interrupted by user]") return true;
  return false;
}

async function readTailPreview(abs: string): Promise<string> {
  // Performance guardrails: do not read full jsonl files.
  // We read up to the last ~96KB and scan backwards for a useful text message.
  const MAX_BYTES = 96 * 1024;
  const MAX_LINES = 600;
  const PREVIEW_MAX_LEN = 120;

  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(abs, "r");
    const st = await fh.stat();
    const size = Number(st.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return "";

    const start = Math.max(0, size - MAX_BYTES);
    const len = size - start;
    if (len <= 0) return "";

    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    if (!lines.length) return "";

    // Keep only tail lines and scan backwards for "user" then "assistant" text.
    const tail = lines.slice(Math.max(0, lines.length - MAX_LINES));
    const parsed: Array<{ type: string; text: string }> = [];
    for (const line of tail) {
      const trimmed = String(line).trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const type = String(obj?.type ?? "");
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj?.message ?? {};
        const content = msg?.content;
        const messageText = extractMessageTextFromContent(content);
        const oneLine = clampOneLinePreview(messageText, PREVIEW_MAX_LEN);
        if (oneLine && !isUnhelpfulPreviewLine(oneLine)) parsed.push({ type, text: oneLine });
      } catch {
        // ignore bad json line
      }
    }

    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === "user") return parsed[i].text;
    }
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === "assistant") return parsed[i].text;
    }
    return "";
  } catch {
    return "";
  } finally {
    try {
      await fh?.close();
    } catch {
      // ignore
    }
  }
}

export async function listClaudeSessions(projectRootPath: string): Promise<ClaudeSessionSummary[]> {
  const dir = claudeProjectDir(projectRootPath);
  let entries: Array<{ name: string; isFile: boolean }> = [];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isFile: d.isFile() }));
  } catch {
    return [];
  }

  const sessions: ClaudeSessionSummary[] = [];
  for (const e of entries) {
    if (!e.isFile) continue;
    if (!SESSION_FILE_RE.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    try {
      const st = await fs.stat(abs);
      if (st.size <= 0) continue;
      sessions.push({
        sessionId: e.name.replace(/\.jsonl$/i, ""),
        fileName: e.name,
        updatedAtMs: st.mtimeMs,
        preview: await readTailPreview(abs)
      });
    } catch {
      // ignore
    }
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return sessions;
}
