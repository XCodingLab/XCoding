export type ClaudeAtMentionRange = { startLine: number; endLine: number };

function normalizeSlashes(value: string) {
  return value.replace(/[\\]+/g, "/");
}

export function normalizeAtMentionPath(input: string) {
  let p = String(input ?? "").trim();
  if (!p) return "";
  p = normalizeSlashes(p);
  p = p.replace(/^(\.\/)+/, "");
  p = p.replace(/\/{2,}/g, "/");
  p = p.replace(/\/+$/, "");
  return p;
}

function escapeQuotedPath(path: string) {
  // Best-effort; file paths with quotes are extremely uncommon.
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function needsQuotes(path: string) {
  return /[\s#"]/.test(path);
}

export function formatAtMentionBody(path: string, range?: ClaudeAtMentionRange | null) {
  const normalizedPath = normalizeAtMentionPath(path);
  const base = needsQuotes(normalizedPath) ? `"${escapeQuotedPath(normalizedPath)}"` : normalizedPath;
  if (!range) return base;
  const startLine = Math.max(1, Math.floor(Math.min(range.startLine, range.endLine)));
  const endLine = Math.max(1, Math.floor(Math.max(range.startLine, range.endLine)));
  return startLine === endLine ? `${base}#${startLine}` : `${base}#${startLine}-${endLine}`;
}

export function formatAtMentionToken(path: string, range?: ClaudeAtMentionRange | null) {
  return `@${formatAtMentionBody(path, range)}`;
}

export function parseAtMentionBody(body: string): { path: string; range: ClaudeAtMentionRange | null } | null {
  let raw = String(body ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("@")) raw = raw.slice(1).trim();
  if (!raw) return null;

  let path = "";
  let rest = "";
  if (raw.startsWith('"')) {
    let i = 1;
    let escaped = false;
    let closed = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (escaped) {
        path += ch;
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        i += 1;
        rest = raw.slice(i);
        closed = true;
        break;
      }
      path += ch;
      i += 1;
    }
    if (!closed) return null;
  } else {
    const hashIdx = raw.indexOf("#");
    const whitespaceIdx = raw.search(/\s/);
    const cut =
      hashIdx === -1 && whitespaceIdx === -1 ? raw.length : hashIdx === -1 ? whitespaceIdx : whitespaceIdx === -1 ? hashIdx : Math.min(hashIdx, whitespaceIdx);
    path = raw.slice(0, cut);
    rest = raw.slice(cut);
  }

  const normalizedPath = normalizeAtMentionPath(path);
  if (!normalizedPath) return null;

  const trimmedRest = String(rest ?? "").trim();
  if (!trimmedRest) return { path: normalizedPath, range: null };
  const m = trimmedRest.match(/^#(\d+)(?:-(\d+))?$/);
  if (!m) return { path: normalizedPath, range: null };
  const startLine = Number(m[1] ?? "0");
  const endLine = Number(m[2] ?? m[1] ?? "0");
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine <= 0 || endLine <= 0) return { path: normalizedPath, range: null };
  return { path: normalizedPath, range: { startLine, endLine } };
}

export function canonicalizeAtMentionBody(body: string) {
  const raw = String(body ?? "").trim();
  if (!raw) return null;
  const parsed = parseAtMentionBody(raw);
  if (parsed) return formatAtMentionBody(parsed.path, parsed.range);

  // Loose fallback: try splitting `path#range` even if path contains whitespace.
  const idx = raw.indexOf("#");
  if (idx !== -1) {
    const pathPart = raw.slice(0, idx).trim();
    const rangePart = raw.slice(idx + 1).trim();
    const m = rangePart.match(/^(\d+)(?:-(\d+))?$/);
    if (m) {
      const startLine = Number(m[1] ?? "0");
      const endLine = Number(m[2] ?? m[1] ?? "0");
      if (startLine > 0 && endLine > 0) return formatAtMentionBody(pathPart, { startLine, endLine });
    }
  }

  return formatAtMentionBody(raw, null);
}

export function extractAtMentionPathsFromText(text: string) {
  const out = new Set<string>();
  const src = String(text ?? "");
  const re = /@(?:"(?:\\.|[^"])*"|[^\s#]+)(?:#\d+(?:-\d+)?)?/g;
  for (const match of src.matchAll(re)) {
    const token = match[0];
    const parsed = parseAtMentionBody(token);
    if (!parsed?.path) continue;
    out.add(normalizeAtMentionPath(parsed.path));
  }
  return out;
}

export function extractTrailingAtMentionBodies(text: string): { visibleText: string; bodies: string[] } {
  const raw = String(text ?? "");
  if (!raw) return { visibleText: raw, bodies: [] };

  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let end = lines.length;
  while (end > 0 && !String(lines[end - 1] ?? "").trim()) end -= 1;
  if (end <= 0) return { visibleText: "", bodies: [] };

  const bodies: string[] = [];
  let i = end - 1;
  while (i >= 0) {
    const line = String(lines[i] ?? "").trim();
    if (!line) break;
    if (!line.startsWith("@")) break;
    const parsed = parseAtMentionBody(line);
    if (!parsed) break;
    const body = canonicalizeAtMentionBody(line);
    if (!body) break;
    bodies.unshift(body);
    i -= 1;
  }

  if (bodies.length === 0) return { visibleText: raw, bodies: [] };
  if (i >= 0 && String(lines[i] ?? "").trim() !== "") return { visibleText: raw, bodies: [] };

  const visibleLines = i < 0 ? [] : lines.slice(0, i);
  const visibleText = visibleLines.join("\n").trimEnd();
  return { visibleText, bodies };
}
