import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

function platformArchDir() {
  // Match typical release naming: e.g. darwin-arm64, darwin-x64, win32-x64, linux-x64
  return `${process.platform}-${process.arch}`;
}

function getBundledCodexPath(): string | null {
  const base = app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), "assets");
  const exeName = process.platform === "win32" ? "codex.exe" : "codex";
  const candidate = path.join(base, "codex", "bin", platformArchDir(), exeName);
  return fs.existsSync(candidate) ? candidate : null;
}

export function resolveCodexExecutablePath(): { path: string | null; source: "override" | "bundled" | "path" } {
  const override = process.env.XCODING_CODEX_PATH;
  if (override && fs.existsSync(override)) return { path: override, source: "override" };

  const bundled = getBundledCodexPath();
  if (bundled) return { path: bundled, source: "bundled" };

  // Fallback: rely on PATH lookup (spawn("codex", ...))
  return { path: null, source: "path" };
}

export function ensureCodexExecutableIsRunnable(executablePath: string) {
  if (process.platform === "win32") return;
  try {
    const st = fs.statSync(executablePath);
    // If executable bit is missing, attempt to fix it (common when copying binaries around).
    if ((st.mode & 0o111) === 0) fs.chmodSync(executablePath, st.mode | 0o755);
  } catch {
    // ignore
  }
}

