import os from "node:os";
import path from "node:path";

export function claudeProjectsRootDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

export function claudeProjectKeyFromProjectRootPath(projectRootPath: string) {
  const normalized = String(projectRootPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "-";
  // Matches Claude Code's on-disk naming pattern: leading "-" + path segments joined by "-".
  return `-${normalized.replace(/^\//, "").replaceAll("/", "-")}`;
}

export function claudeProjectDir(projectRootPath: string) {
  return path.join(claudeProjectsRootDir(), claudeProjectKeyFromProjectRootPath(projectRootPath));
}

