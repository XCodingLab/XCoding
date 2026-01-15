export type ReviewFile = { path: string; added: number; removed: number; kind?: string; diff: string };

export type FileChangeSummary = {
  files: Array<{ path: string; added: number; removed: number }>;
  diff: string;
  reviewFiles: ReviewFile[];
};

function normalizeDiffPath(p: string) {
  const trimmed = String(p ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "/dev/null") return "";
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function normalizeKind(kind?: string) {
  return String(kind ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function isAddKind(kind?: string) {
  const k = normalizeKind(kind);
  if (!k) return false;
  return k === "add" || k === "added" || k === "create" || k === "new" || k === "addfile" || k === "createfile" || k === "newfile";
}

function isDeleteKind(kind?: string) {
  const k = normalizeKind(kind);
  if (!k) return false;
  return (
    k === "delete" ||
    k === "del" ||
    k === "rm" ||
    k === "remove" ||
    k === "deleted" ||
    k === "removed" ||
    k === "deletefile" ||
    k === "removefile" ||
    k === "deletedfile"
  );
}

function isMetaLine(line: string) {
  const s = String(line ?? "");
  return (
    s.startsWith("*** ") ||
    s.startsWith("diff --git ") ||
    s.startsWith("index ") ||
    s.startsWith("--- ") ||
    s.startsWith("+++ ") ||
    s.startsWith("new file mode ") ||
    s.startsWith("deleted file mode ") ||
    s.startsWith("rename from ") ||
    s.startsWith("rename to ") ||
    s.startsWith("rename ") ||
    s.startsWith("similarity index ") ||
    s.startsWith("dissimilarity index ") ||
    s.startsWith("@@") ||
    s === "\\ No newline at end of file"
  );
}

function countAddedRemovedFromDiff(diffText: string, kind?: string) {
  const raw = String(diffText ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (isMetaLine(line)) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }

  // Some Codex/app-server variants emit Add File bodies without '+' prefixes.
  if (added === 0 && isAddKind(kind)) {
    let contentLines = 0;
    for (const line of lines) {
      if (isMetaLine(line)) continue;
      contentLines += 1;
    }
    added = contentLines;
  }

  // Delete File bodies often omit content; keep best-effort symmetry if content is present.
  if (removed === 0 && isDeleteKind(kind)) {
    let contentLines = 0;
    for (const line of lines) {
      if (isMetaLine(line)) continue;
      contentLines += 1;
    }
    removed = contentLines;
  }
  return { added, removed };
}

function isRecognizableDiff(diffText: string) {
  const raw = String(diffText ?? "");
  if (!raw.trim()) return false;
  return (
    raw.includes("*** Begin Patch") ||
    /^\*\*\* (Add File|Update File|Delete File):/m.test(raw) ||
    raw.includes("diff --git ") ||
    /^\s*(--- |\+\+\+ |@@)/m.test(raw)
  );
}

export function computeFileChangeSummary(turn: { items?: any[]; diff?: string | null }): FileChangeSummary | null {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const fileChanges = items.filter((it: any) => String(it?.type ?? "") === "fileChange");
  if (!fileChanges.length) return null;

  const byPath = new Map<string, { path: string; added: number; removed: number; kind?: string; parts: string[] }>();

  let combinedDiff = "";
  const applyPatchParts: string[] = [];
  for (const fc of fileChanges) {
    const changes = Array.isArray((fc as any)?.changes) ? (fc as any).changes : [];
    for (const c of changes) {
      const p = String(c?.path ?? "").trim();
      if (!p) continue;
      const kind = String(c?.kind?.type ?? c?.kind ?? "").trim() || undefined;
      const diff = String(c?.diff ?? "");
      const { added, removed } = countAddedRemovedFromDiff(diff, kind);
      const prev = byPath.get(p) ?? { path: p, added: 0, removed: 0, kind, parts: [] };
      prev.added += added;
      prev.removed += removed;
      if (!prev.kind && kind) prev.kind = kind;
      byPath.set(p, prev);

      const trimmed = diff.trim();
      if (!trimmed) continue;
      prev.parts.push(trimmed);
      if (isRecognizableDiff(trimmed)) combinedDiff += (combinedDiff ? "\n" : "") + trimmed + "\n";
      else applyPatchParts.push(`*** Update File: ${p}\n${trimmed}\n`);
    }
  }

  const files = Array.from(byPath.values())
    .map((f) => ({ path: f.path, added: f.added, removed: f.removed }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return null;
  const reviewFiles = Array.from(byPath.values())
    .map((f) => ({ path: f.path, added: f.added, removed: f.removed, kind: f.kind, diff: f.parts.join("\n").trim() }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const fallbackDiff = typeof (turn as any)?.diff === "string" ? String((turn as any).diff) : "";
  const fallbackTrimmed = fallbackDiff.trim();
  const diff =
    fallbackTrimmed && isRecognizableDiff(fallbackTrimmed)
      ? fallbackTrimmed
      : combinedDiff.trim()
        ? combinedDiff.trim()
        : applyPatchParts.length
          ? `*** Begin Patch\n${applyPatchParts.join("\n").trim()}\n*** End Patch`
          : fallbackTrimmed || "";

  return { files, diff, reviewFiles };
}

export function reviewFilesFromDiffText(diffText: string): ReviewFile[] {
  const raw = String(diffText ?? "").replace(/\r\n/g, "\n");
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // apply_patch format
  if (/^\*\*\* (Add File|Update File|Delete File):/m.test(trimmed) || trimmed.includes("*** Begin Patch")) {
    const lines = trimmed.split("\n");
    const files: Array<{ path: string; kind?: string; lines: string[] }> = [];
    let current: { path: string; kind?: string; lines: string[] } | null = null;

    const flush = () => {
      if (!current) return;
      const body = current.lines.join("\n").trim();
      if (current.path && body) files.push({ path: current.path, kind: current.kind, lines: [body] });
      current = null;
    };

    for (const line of lines) {
      const header = line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
      if (header?.[2]) {
        flush();
        const kind = String(header[1]).replaceAll(" ", "").toLowerCase();
        current = { path: normalizeDiffPath(String(header[2]).trim()), kind, lines: [line] };
        continue;
      }
      if (!current) continue;
      current.lines.push(line);
    }
    flush();

    return files
      .map((f) => {
        const diff = f.lines.join("\n").trim();
        const { added, removed } = countAddedRemovedFromDiff(diff, f.kind);
        return { path: f.path, added, removed, kind: f.kind, diff };
      })
      .filter((f) => Boolean(f.path));
  }

  // unified diff format
  const lines = trimmed.split("\n");
  const sections: Array<{ path: string; lines: string[] }> = [];
  let current: { path: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (current.path && body) sections.push({ path: current.path, lines: [body] });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/);
      const p = normalizeDiffPath(m?.[2] ?? m?.[1] ?? "");
      current = { path: p || "unknown", lines: [line] };
      continue;
    }
    if (!current) {
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) current = { path: "unknown", lines: [] };
      else continue;
    }
    current.lines.push(line);
    if (line.startsWith("+++ ")) {
      const p = normalizeDiffPath(line.slice(4));
      if (p) current.path = p;
    }
  }
  flush();

  return sections
    .map((s) => {
      const diff = s.lines.join("\n").trim();
      const { added, removed } = countAddedRemovedFromDiff(diff);
      const normalizedPath = s.path === "unknown" ? "" : normalizeDiffPath(s.path);
      return { path: normalizedPath, added, removed, diff };
    })
    .filter((f) => Boolean(f.path));
}
