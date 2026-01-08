import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type ClaudeCodeBundle = { version: string; cliJsPath: string; baseDir: string };

function readBundledVersion(baseDir: string): string | null {
  const p = path.join(baseDir, "claude-code", "version.txt");
  try {
    const v = fs.readFileSync(p, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function resolveDevAssetsRoot(): string {
  return path.resolve(process.cwd(), "assets");
}

function resolveProdResourcesRoot(): string {
  return process.resourcesPath;
}

export function resolveBundledClaudeCode(): ClaudeCodeBundle | null {
  const baseDir = app.isPackaged ? resolveProdResourcesRoot() : resolveDevAssetsRoot();
  const version = readBundledVersion(baseDir);
  if (!version) return null;

  const cliJsPath = path.join(baseDir, "claude-code", version, "cli.js");
  if (!fs.existsSync(cliJsPath)) return null;
  return { version, cliJsPath, baseDir };
}

