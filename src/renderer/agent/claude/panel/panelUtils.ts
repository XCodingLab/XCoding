import type { ProposedDiffCardPreview } from "../../shared/ProposedDiffCard";
import type { ClaudePermissionMode } from "./types";

export function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseToolMessage(text: string) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("tool_use:") && !trimmed.startsWith("tool_result")) return null;

  const firstNewline = trimmed.indexOf("\n");
  const firstLine = (firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline)).trim();
  const rest = firstNewline === -1 ? "" : trimmed.slice(firstNewline + 1);

  if (firstLine.startsWith("tool_use:")) {
    const name = firstLine.replace(/^tool_use:\s*/, "").trim();
    return { kind: "tool_use" as const, title: name || "tool", detail: rest.trim() };
  }

  // tool_result (maybe contains "(toolUseId)" and "[error]" markers)
  return { kind: "tool_result" as const, title: firstLine, detail: rest.trim() };
}

export function parseRelFileHref(href: string): null | { relPath: string; line?: number; column?: number } {
  const raw = String(href ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return null;
  if (/^[a-zA-Z]+:\/\//.test(raw)) return null;

  // Strip leading "./"
  let url = raw.replace(/^\.\/+/, "");
  if (!url || url.startsWith("..")) return null;

  // Support foo.ts#L10 or foo.ts#L10-L20
  let anchorLine: number | undefined;
  const hashIdx = url.indexOf("#");
  if (hashIdx !== -1) {
    const before = url.slice(0, hashIdx);
    const hash = url.slice(hashIdx + 1);
    url = before;
    const m = hash.match(/^L(\d+)(?:-(?:L)?(\d+))?$/i);
    if (m) anchorLine = Number(m[1]);
  }

  // Support foo.ts:10 or foo.ts:10:3 or foo.ts:10-20 (take first line)
  let relPath = url;
  let line: number | undefined = anchorLine;
  let column: number | undefined;
  const mRange = relPath.match(/:(\d+)-(\d+)$/);
  if (mRange) {
    relPath = relPath.slice(0, relPath.length - mRange[0].length);
    line = Number(mRange[1]);
  } else {
    const mPos = relPath.match(/:(\d+)(?::(\d+))?$/);
    if (mPos) {
      relPath = relPath.slice(0, relPath.length - mPos[0].length);
      line = Number(mPos[1]);
      if (mPos[2]) column = Number(mPos[2]);
    }
  }

  relPath = relPath.trim();
  if (!relPath || relPath.startsWith("..")) return null;
  if (!line || !Number.isFinite(line) || line <= 0) line = undefined;
  if (!column || !Number.isFinite(column) || column <= 0) column = undefined;
  return { relPath, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function toProposedDiffCardPreview(value: any): ProposedDiffCardPreview | null {
  if (!value || typeof value !== "object") return null;
  if (value.loading === true) return { kind: "loading" };
  if (typeof value.error === "string" && value.error.trim()) return { kind: "error", error: value.error };
  const relPath = typeof value.relPath === "string" ? value.relPath : typeof value.path === "string" ? value.path : "";
  const unifiedDiff = typeof value.unifiedDiff === "string" ? value.unifiedDiff : "";
  if (!relPath && !unifiedDiff.trim()) return null;
  return {
    kind: "diff",
    relPath: relPath || "unknown",
    unifiedDiff,
    added: typeof value.added === "number" ? value.added : undefined,
    removed: typeof value.removed === "number" ? value.removed : undefined,
    atMs: typeof value.atMs === "number" ? value.atMs : undefined
  };
}

export function modeLabel(mode: ClaudePermissionMode) {
  switch (mode) {
    case "default":
      return "default";
    case "acceptEdits":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "bypassPermissions";
    default:
      return "default";
  }
}

// Keep these strings exactly aligned with the official VS Code plugin webview build.
export const OFFICIAL_DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
export const OFFICIAL_STAY_IN_PLAN_MESSAGE = "User chose to stay in plan mode and continue planning";

export function coerceNonEmptyString(value: unknown): string | null {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  const trimmed = s.trim();
  return trimmed ? trimmed : null;
}

export function isUnhelpfulHistoryMarkerLine(text: string) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (t === "no response requested.") return true;
  if (t === "[request interrupted by user]") return true;
  return false;
}

