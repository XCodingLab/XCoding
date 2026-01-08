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
        updatedAtMs: st.mtimeMs
      });
    } catch {
      // ignore
    }
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return sessions;
}
