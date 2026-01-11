import fs from "node:fs/promises";
import path from "node:path";
import { countMyersLineDiff, makeUnifiedDiff } from "./unifiedDiff";

export type ProposedDiffPreview = {
  absPath: string;
  relPath: string;
  unifiedDiff: string;
  added: number;
  removed: number;
  atMs: number;
  error?: string;
};

function isSubpath(parent: string, candidate: string) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedParent) return true;
  return resolvedCandidate.startsWith(resolvedParent + path.sep);
}

function normalizeRelPath(p: string) {
  // Keep diff paths stable across OS.
  return p.split(path.sep).join("/");
}

async function pathExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function applySingleEdit(original: string, oldString: string, newString: string, replaceAll: boolean) {
  if (!oldString) throw new Error("old_string must be non-empty");
  if (replaceAll) {
    const replaced = original.split(oldString).join(newString);
    if (replaced === original) throw new Error("old_string not found");
    return replaced;
  }
  const idx = original.indexOf(oldString);
  if (idx === -1) throw new Error("old_string not found");
  return original.slice(0, idx) + newString + original.slice(idx + oldString.length);
}

async function resolveToolPath(projectRootPath: string, filePath: string) {
  const root = path.resolve(projectRootPath);
  const raw = String(filePath ?? "").trim();
  if (!raw) throw new Error("missing file_path");
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!isSubpath(root, abs)) throw new Error("file_path must be within projectRootPath");
  const rel = path.relative(root, abs) || path.basename(abs);
  return { absPath: abs, relPath: normalizeRelPath(rel) };
}

function countAddedRemovedFromUnifiedDiff(unifiedDiff: string) {
  const lines = String(unifiedDiff ?? "").replace(/\r\n/g, "\n").split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line[0] === "+") added += 1;
    else if (line[0] === "-") removed += 1;
  }
  return { added, removed };
}

export async function computeProposedDiffPreview({
  projectRootPath,
  toolName,
  toolInput,
  signal
}: {
  projectRootPath: string;
  toolName: "Write" | "Edit" | "MultiEdit";
  toolInput: any;
  signal?: AbortSignal;
}): Promise<ProposedDiffPreview> {
  const { absPath, relPath } = await resolveToolPath(projectRootPath, toolInput?.file_path);

  if (signal?.aborted) throw new Error("aborted");

  const exists = await pathExists(absPath);
  const before = exists ? await fs.readFile(absPath, "utf8") : "";

  let after = before;
  if (toolName === "Write") {
    after = String(toolInput?.content ?? "");
  } else if (toolName === "Edit") {
    after = applySingleEdit(
      before,
      String(toolInput?.old_string ?? ""),
      String(toolInput?.new_string ?? ""),
      Boolean(toolInput?.replace_all)
    );
  } else {
    const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : null;
    if (!edits?.length) throw new Error("missing edits");
    let next = before;
    for (const e of edits) {
      next = applySingleEdit(next, String(e?.old_string ?? ""), String(e?.new_string ?? ""), Boolean(e?.replace_all));
    }
    after = next;
  }

  if (signal?.aborted) throw new Error("aborted");

  const unified = makeUnifiedDiff({ oldText: before, newText: after, pathLabel: relPath });
  const unifiedDiff = unified?.diff ?? "";
  const stats = countMyersLineDiff(before, after) ?? countAddedRemovedFromUnifiedDiff(unifiedDiff);
  const { added, removed } = stats;
  if (!unified) {
    return { absPath, relPath, unifiedDiff: "", added, removed, atMs: Date.now(), error: "diff preview unavailable" };
  }

  return { absPath, relPath, unifiedDiff, added, removed, atMs: Date.now() };
}
