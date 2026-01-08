import fs from "node:fs/promises";
import path from "node:path";
import { claudeProjectDir } from "../history/claudeProjectKey";
import { readClaudeFileBackup } from "./fileHistory";

async function readLatestSnapshot({
  projectRootPath,
  sessionId
}: {
  projectRootPath: string;
  sessionId: string;
}): Promise<{ trackedFileBackups: Record<string, string>; messageId?: string } | null> {
  const abs = path.join(claudeProjectDir(projectRootPath), `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj?.type !== "file-history-snapshot") continue;
      const snap = obj?.snapshot ?? {};
      const backups = snap?.trackedFileBackups ?? {};
      if (!backups || typeof backups !== "object") continue;
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(backups)) {
        if (typeof v === "string") mapped[String(k)] = v;
        else if (v && typeof v === "object" && typeof (v as any).backupName === "string") mapped[String(k)] = String((v as any).backupName);
      }
      return { trackedFileBackups: mapped, messageId: String(obj?.messageId ?? "") || undefined };
    } catch {
      continue;
    }
  }
  return null;
}

export async function claudeLatestSnapshotFiles({
  projectRootPath,
  sessionId
}: {
  projectRootPath: string;
  sessionId: string;
}) {
  const snapshot = await readLatestSnapshot({ projectRootPath, sessionId });
  if (!snapshot) return { ok: false as const, reason: "no_snapshot" as const };
  const files = Object.entries(snapshot.trackedFileBackups).map(([absPath, backupName]) => ({ absPath, backupName }));
  return { ok: true as const, files, messageId: snapshot.messageId };
}

export async function claudeTurnFileDiff({
  projectRootPath,
  sessionId,
  absPath
}: {
  projectRootPath: string;
  sessionId: string;
  absPath: string;
}) {
  const snapshot = await readLatestSnapshot({ projectRootPath, sessionId });
  if (!snapshot) return { ok: false as const, reason: "no_snapshot" as const };
  const backupName = snapshot.trackedFileBackups[String(absPath)] ?? null;
  if (!backupName) return { ok: false as const, reason: "no_backup_for_file" as const, messageId: snapshot.messageId };

  const original = await readClaudeFileBackup(sessionId, backupName);
  const modified = await fs.readFile(absPath, "utf8");
  return { ok: true as const, original, modified, backupName, messageId: snapshot.messageId };
}
