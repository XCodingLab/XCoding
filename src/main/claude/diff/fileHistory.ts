import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function claudeFileHistoryRootDir() {
  return path.join(os.homedir(), ".claude", "file-history");
}

export async function readClaudeFileBackup(sessionId: string, backupName: string) {
  const abs = path.join(claudeFileHistoryRootDir(), sessionId, backupName);
  return await fs.readFile(abs, "utf8");
}

