import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";

type DiffRow =
  | { kind: "meta"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "context"; oldLine: number | null; newLine: number | null; oldText: string; newText: string }
  | { kind: "add"; oldLine: null; newLine: number | null; oldText: ""; newText: string }
  | { kind: "remove"; oldLine: number | null; newLine: null; oldText: string; newText: "" };

type DiffFile = {
  key: string;
  path: string;
  oldPath?: string;
  newPath?: string;
  added: number;
  removed: number;
  rows: DiffRow[];
};

function safeTrimPrefix(value: string, prefix: string) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function normalizeDiffPath(p: string) {
  const trimmed = String(p ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "/dev/null") return trimmed;
  const noA = safeTrimPrefix(trimmed, "a/");
  const noB = safeTrimPrefix(noA, "b/");
  return noB;
}

function parseHunkHeader(line: string) {
  // @@ -a,b +c,d @@ optional
  const m = line.match(/^@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[3]) };
}

function parseApplyPatchDiff(input: string): DiffFile[] {
  const raw = String(input ?? "");
  const allLines = raw.replace(/\r\n/g, "\n").split("\n");

  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 1;
  let newLine = 1;

  const flush = () => {
    if (!current) return;
    if (current.rows.some((r) => (r.kind === "meta" || r.kind === "hunk" ? r.text.trim() : true))) files.push(current);
    current = null;
    oldLine = 1;
    newLine = 1;
  };

  for (const line of allLines) {
    if (line === "") continue;
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;

    const header = line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
    if (header) {
      flush();
      const p = String(header[2] ?? "").trim();
      current = {
        key: `${files.length}:${p || "unknown"}`,
        path: p || "unknown",
        added: 0,
        removed: 0,
        rows: []
      };
      continue;
    }

    if (!current) {
      // Ignore non-file content for apply_patch format.
      continue;
    }

    if (line.startsWith("*** Move to:")) {
      current.rows.push({ kind: "meta", text: line });
      continue;
    }

    if (line.startsWith("@@")) {
      current.rows.push({ kind: "hunk", text: line });
      continue;
    }

    const prefix = line[0];
    const content = line.length > 1 ? line.slice(1) : "";
    if (prefix === "+") {
      current.added += 1;
      current.rows.push({ kind: "add", oldLine: null, newLine, oldText: "", newText: content });
      newLine += 1;
    } else if (prefix === "-") {
      current.removed += 1;
      current.rows.push({ kind: "remove", oldLine, newLine: null, oldText: content, newText: "" });
      oldLine += 1;
    } else if (prefix === " ") {
      current.rows.push({ kind: "context", oldLine, newLine, oldText: content, newText: content });
      oldLine += 1;
      newLine += 1;
    } else {
      current.rows.push({ kind: "meta", text: line });
    }
  }

  flush();
  return files;
}

function parseUnifiedDiff(input: string): DiffFile[] {
  const raw = String(input ?? "");
  const allLines = raw.replace(/\r\n/g, "\n").split("\n");

  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  const flush = () => {
    if (!current) return;
    if (current.rows.length) files.push(current);
    current = null;
    oldLine = null;
    newLine = null;
  };

  for (const line of allLines) {
    if (line === "") continue;
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;

    if (line.startsWith("diff --git ")) {
      flush();
      const m = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/);
      const p = normalizeDiffPath(m?.[2] ?? m?.[1] ?? "");
      current = {
        key: `${files.length}:${p || "unknown"}`,
        path: p || "unknown",
        oldPath: m?.[1] ? normalizeDiffPath(m[1]) : undefined,
        newPath: m?.[2] ? normalizeDiffPath(m[2]) : undefined,
        added: 0,
        removed: 0,
        rows: [{ kind: "meta", text: line }]
      };
      continue;
    }

    if (!current) {
      // Start on first marker.
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
        current = {
          key: `${files.length}:unknown`,
          path: "unknown",
          added: 0,
          removed: 0,
          rows: []
        };
      } else {
        continue;
      }
    }

    if (line.startsWith("--- ")) {
      const p = normalizeDiffPath(line.slice(4));
      current.oldPath = p;
      current.rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = normalizeDiffPath(line.slice(4));
      current.newPath = p;
      const best = p && p !== "/dev/null" ? p : current.oldPath && current.oldPath !== "/dev/null" ? current.oldPath : current.path;
      if (best && best !== "unknown") current.path = best;
      current.key = `${files.length}:${current.path}`;
      current.rows.push({ kind: "meta", text: line });
      continue;
    }

    if (line.startsWith("index ") || line.startsWith("new file mode ") || line.startsWith("deleted file mode ") || line.startsWith("rename ")) {
      current.rows.push({ kind: "meta", text: line });
      continue;
    }

    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      oldLine = parsed ? parsed.oldStart : oldLine;
      newLine = parsed ? parsed.newStart : newLine;
      current.rows.push({ kind: "hunk", text: line });
      continue;
    }

    const prefix = line[0];
    const content = line.length > 1 ? line.slice(1) : "";
    if (prefix === " ") {
      current.rows.push({ kind: "context", oldLine, newLine, oldText: content, newText: content });
      if (typeof oldLine === "number") oldLine += 1;
      if (typeof newLine === "number") newLine += 1;
    } else if (prefix === "+") {
      if (line.startsWith("+++")) continue;
      current.added += 1;
      current.rows.push({ kind: "add", oldLine: null, newLine, oldText: "", newText: content });
      if (typeof newLine === "number") newLine += 1;
    } else if (prefix === "-") {
      if (line.startsWith("---")) continue;
      current.removed += 1;
      current.rows.push({ kind: "remove", oldLine, newLine: null, oldText: content, newText: "" });
      if (typeof oldLine === "number") oldLine += 1;
    } else {
      current.rows.push({ kind: "meta", text: line });
    }
  }

  flush();
  return files;
}

function parseDiff(input: string): DiffFile[] {
  const raw = String(input ?? "");
  if (!raw.trim()) return [];
  if (/^\*\*\* (Add File|Update File|Delete File):/m.test(raw) || raw.includes("*** Begin Patch")) {
    const parsed = parseApplyPatchDiff(raw);
    if (parsed.length) return parsed;
  }
  return parseUnifiedDiff(raw);
}

function formatCounts(added: number, removed: number) {
  const a = added > 0 ? `+${added}` : "";
  const r = removed > 0 ? `-${removed}` : "";
  return [a, r].filter(Boolean).join(" ");
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["min-w-0 px-2 py-0.5", className ?? ""].join(" ")}>{children}</div>;
}

export default function CodexDiffView({ diff }: { diff: string }) {
  const { t } = useI18n();
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [selectedKey, setSelectedKey] = useState<string>("");

  useEffect(() => {
    if (!files.length) {
      setSelectedKey("");
      return;
    }
    if (selectedKey && files.some((f) => f.key === selectedKey)) return;
    setSelectedKey(files[0].key);
  }, [files, selectedKey]);

  const selected = useMemo(() => files.find((f) => f.key === selectedKey) ?? files[0] ?? null, [files, selectedKey]);

  if (!diff.trim()) {
    return <div className="p-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("codexDiffNoData")}</div>;
  }

  if (!files.length) {
    return (
      <div className="p-2">
        <div className="mb-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("codexDiffUnrecognized")}</div>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[11px] text-[var(--vscode-foreground)]">
          {diff}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[200px] shrink-0 border-r border-[var(--vscode-panel-border)]">
        <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
          {t("files")} ({files.length})
        </div>
        <div className="h-[calc(100%-2rem)] overflow-auto p-1">
          {files.map((f) => {
            const active = selected?.key === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setSelectedKey(f.key)}
                className={[
                  "w-full rounded px-2 py-1 text-left",
                  active ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]" : "hover:bg-[var(--vscode-list-hoverBackground)]"
                ].join(" ")}
                title={f.path}
              >
                <div className="truncate text-[11px]">{f.path}</div>
                <div className={["text-[10px]", active ? "text-white/80" : "text-[var(--vscode-descriptionForeground)]"].join(" ")}>
                  {formatCounts(f.added, f.removed) || "no changes"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="border-b border-[var(--vscode-panel-border)] px-2 py-2 text-[11px] text-[var(--vscode-foreground)]">
          <span className="font-semibold">Diff:</span> {selected?.path ?? ""}
        </div>
        <div className="h-[calc(100%-2.25rem)] overflow-auto">
          <div className="min-w-max font-mono text-[11px] leading-4 text-[var(--vscode-foreground)]">
            <div className="grid grid-cols-[52px,minmax(0,1fr),1px,52px,minmax(0,1fr)]">
              {selected?.rows.map((row, idx) => {
                if (row.kind === "meta" || row.kind === "hunk") {
                  const cls =
                    row.kind === "hunk"
                      ? "text-[color-mix(in_srgb,var(--vscode-focusBorder)_85%,white)]"
                      : "text-[var(--vscode-descriptionForeground)]";
                  return (
                    <div key={idx} className="col-span-5 border-b border-[color-mix(in_srgb,var(--vscode-panel-border)_55%,transparent)] px-2 py-1">
                      <span className={cls}>{row.text}</span>
                    </div>
                  );
                }

                const lineNumCls = "tabular-nums text-[10px] text-[var(--vscode-descriptionForeground)]";
                const oldBg = row.kind === "remove" ? "bg-[color-mix(in_srgb,#f14c4c_14%,transparent)]" : "";
                const newBg = row.kind === "add" ? "bg-[color-mix(in_srgb,#89d185_14%,transparent)]" : "";
                const oldFg = row.kind === "remove" ? "text-[color-mix(in_srgb,#f14c4c_90%,white)]" : "text-[var(--vscode-foreground)]";
                const newFg = row.kind === "add" ? "text-[color-mix(in_srgb,#89d185_90%,white)]" : "text-[var(--vscode-foreground)]";

                return (
                  <div key={idx} className="contents">
                    <Cell className={["text-right", lineNumCls, oldBg].join(" ")}>{typeof row.oldLine === "number" ? row.oldLine : ""}</Cell>
                    <Cell className={[oldBg, oldFg].join(" ")}>
                      <span className="whitespace-pre">{row.oldText || (row.kind === "add" ? "" : " ")}</span>
                    </Cell>
                    <div className="bg-[color-mix(in_srgb,var(--vscode-panel-border)_55%,transparent)]" />
                    <Cell className={["text-right", lineNumCls, newBg].join(" ")}>{typeof row.newLine === "number" ? row.newLine : ""}</Cell>
                    <Cell className={[newBg, newFg].join(" ")}>
                      <span className="whitespace-pre">{row.newText || (row.kind === "remove" ? "" : " ")}</span>
                    </Cell>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
