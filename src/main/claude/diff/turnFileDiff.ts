import fs from "node:fs/promises";
import path from "node:path";
import { claudeProjectDir } from "../history/claudeProjectKey";
import { readClaudeFileBackup } from "./fileHistory";
import { countMyersLineDiff, makeUnifiedDiff } from "./unifiedDiff";

function normalizeRelPathForDiff(relPath: string): string {
  return String(relPath ?? "").split(path.sep).join("/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

function tryProjectRelativePath(projectRootPath: string, absPath: string): string | undefined {
  const root = String(projectRootPath ?? "");
  const abs = String(absPath ?? "");
  if (!root || !abs) return undefined;
  const rel = path.relative(root, abs);
  const normalized = normalizeRelPathForDiff(rel);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

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

  const entries = Object.entries(snapshot.trackedFileBackups).map(([absPath, backupName]) => ({ absPath, backupName }));
  const files = await mapWithConcurrency(entries, 4, async (row) => {
    const absPath = String(row.absPath ?? "");
    const backupName = String(row.backupName ?? "");
    const relPath = tryProjectRelativePath(projectRootPath, absPath);
    try {
      const original = await readClaudeFileBackup(sessionId, backupName);
      const modified = await fs.readFile(absPath, "utf8");
      const stats = countMyersLineDiff(original, modified);
      return {
        absPath,
        backupName,
        relPath,
        added: stats?.added,
        removed: stats?.removed,
        truncated: stats == null
      };
    } catch (e) {
      return { absPath, backupName, relPath, error: e instanceof Error ? e.message : String(e) };
    }
  });

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
  const stats = countMyersLineDiff(original, modified);
  const relPath = tryProjectRelativePath(projectRootPath, absPath);
  const unified = makeUnifiedDiff({ oldText: original, newText: modified, pathLabel: relPath || absPath });
  return {
    ok: true as const,
    original,
    modified,
    backupName,
    messageId: snapshot.messageId,
    relPath,
    added: stats?.added,
    removed: stats?.removed,
    unifiedDiff: unified?.diff ?? "",
    unifiedTruncated: unified?.truncated ?? false
  };
}
