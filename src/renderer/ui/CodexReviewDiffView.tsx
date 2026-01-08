import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { ensureMonacoLanguage, MONACO_THEME_NAME, MONACO_URI_SCHEME } from "../monacoSetup";
import { useI18n } from "./i18n";

type ReviewFile = { path: string; added: number; removed: number; kind?: string; diff: string };

function guessLanguageIdFromPath(relPath: string) {
  const p = String(relPath ?? "").toLowerCase();
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".css") || p.endsWith(".scss") || p.endsWith(".less")) return "css";
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".md") || p.endsWith(".markdown") || p.endsWith(".mdx")) return "markdown";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".java")) return "java";
  return "plaintext";
}

function formatCounts(added: number, removed: number) {
  const a = added > 0 ? `+${added}` : "";
  const r = removed > 0 ? `-${removed}` : "";
  return [a, r].filter(Boolean).join(" ");
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
    s === "\\ No newline at end of file"
  );
}

function toOriginalAndModified(diffText: string, kind?: string) {
  const raw = String(diffText ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const original: string[] = [];
  const modified: string[] = [];

  for (const line of lines) {
    if (line === "") {
      original.push("");
      modified.push("");
      continue;
    }
    const normalized = line.replace(/^\uFEFF/, "");
    if (isMetaLine(normalized)) continue;
    if (normalized.startsWith("@@")) continue;

    const prefix = normalized[0];
    const content = normalized.length > 1 ? normalized.slice(1) : "";

    if (prefix === "+") {
      modified.push(content);
      continue;
    }
    if (prefix === "-") {
      original.push(content);
      continue;
    }
    if (prefix === " ") {
      original.push(content);
      modified.push(content);
      continue;
    }

    // Raw diffs sometimes omit the prefix; treat as context.
    original.push(normalized);
    modified.push(normalized);
  }

  const kindValue = String(kind ?? "").toLowerCase();
  const isAdd = kindValue === "addfile" || (kindValue.includes("add") && kindValue.includes("file"));
  const isDelete = kindValue === "deletefile" || (kindValue.includes("delete") && kindValue.includes("file"));

  if (isAdd) return { original: "", modified: modified.join("\n") };
  if (isDelete) return { original: original.join("\n"), modified: "" };
  return { original: original.join("\n"), modified: modified.join("\n") };
}

function stripMetaAndHunks(diffText: string) {
  const raw = String(diffText ?? "").replace(/\r\n/g, "\n");
  return raw
    .split("\n")
    .map((l) => l.replace(/^\uFEFF/, ""))
    .filter((l) => l && !isMetaLine(l) && !l.startsWith("@@"));
}

function applyLineDiffToOriginal(originalText: string, diffText: string, kind?: string) {
  const kindValue = String(kind ?? "").toLowerCase();
  const isAdd = kindValue === "addfile" || (kindValue.includes("add") && kindValue.includes("file"));
  const isDelete = kindValue === "deletefile" || (kindValue.includes("delete") && kindValue.includes("file"));
  if (isAdd) {
    const lines = stripMetaAndHunks(diffText);
    const modified = lines
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1))
      .join("\n");
    return { original: "", modified };
  }
  if (isDelete) return { original: originalText, modified: "" };

  const originalLines = String(originalText ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const diffLines = stripMetaAndHunks(diffText);

  let i = 0;
  const takeIfMatches = (expected: string) => {
    if (i < originalLines.length && originalLines[i] === expected) {
      i += 1;
      return true;
    }
    return false;
  };

  for (const line of diffLines) {
    const prefix = line[0];
    const content = line.length > 1 ? line.slice(1) : "";
    if (prefix === " ") {
      // Context: try to advance the original pointer to the matching line.
      while (i < originalLines.length && originalLines[i] !== content) {
        out.push(originalLines[i]);
        i += 1;
      }
      if (i < originalLines.length && originalLines[i] === content) {
        out.push(content);
        i += 1;
      } else {
        out.push(content);
      }
      continue;
    }
    if (prefix === "-") {
      // Removal: best-effort consume a matching line; otherwise ignore.
      if (!takeIfMatches(content)) {
        // try search forward a little to keep alignment reasonable
        const lookahead = 40;
        let foundAt = -1;
        for (let j = i; j < Math.min(originalLines.length, i + lookahead); j++) {
          if (originalLines[j] === content) {
            foundAt = j;
            break;
          }
        }
        if (foundAt >= 0) i = foundAt + 1;
      }
      continue;
    }
    if (prefix === "+") {
      out.push(content);
      continue;
    }
    // Unknown line: treat as context.
    out.push(line);
  }

  // Append rest of original content.
  while (i < originalLines.length) {
    out.push(originalLines[i]);
    i += 1;
  }

  return { original: originalText, modified: out.join("\n") };
}

export default function CodexReviewDiffView({
  tabId,
  slot,
  threadId,
  turnId,
  files,
  activePath
}: {
  tabId: string;
  slot: number;
  threadId: string;
  turnId: string;
  files: ReviewFile[];
  activePath?: string;
}) {
  const { t } = useI18n();
  const [selectedPath, setSelectedPath] = useState("");
  const [diffState, setDiffState] = useState<{
    loading: boolean;
    error?: string;
    original: string;
    modified: string;
    truncated: boolean;
    isBinary: boolean;
  }>({ loading: true, original: "", modified: "", truncated: false, isBinary: false });

  useEffect(() => {
    const desired = typeof activePath === "string" && activePath.trim() ? activePath.trim() : "";
    if (desired && files.some((f) => f.path === desired)) {
      setSelectedPath(desired);
      return;
    }
    if (!selectedPath || !files.some((f) => f.path === selectedPath)) setSelectedPath(files[0]?.path ?? "");
  }, [activePath, files, selectedPath]);

  const selected = useMemo(() => files.find((f) => f.path === selectedPath) ?? files[0] ?? null, [files, selectedPath]);
  const language = useMemo(() => guessLanguageIdFromPath(selected?.path ?? ""), [selected?.path]);

  useEffect(() => {
    void ensureMonacoLanguage(language).catch(() => {});
  }, [language]);

  useEffect(() => {
    if (!selected) {
      setDiffState({ loading: false, original: "", modified: "", truncated: false, isBinary: false });
      return;
    }
    let cancelled = false;
    setDiffState((prev) => ({ ...prev, loading: true, error: undefined, truncated: false, isBinary: false }));
    void (async () => {
      const res = await window.xcoding.codex.turnFileDiff({ threadId, turnId, path: selected.path });
      if (cancelled) return;
      if (res.ok) {
        setDiffState({
          loading: false,
          error: undefined,
          original: res.original ?? "",
          modified: res.modified ?? "",
          truncated: Boolean(res.truncated),
          isBinary: Boolean(res.isBinary)
        });
        return;
      }

      const fileRes = await window.xcoding.project.readFile({ slot, path: selected.path });
      if (cancelled) return;
      const baseOriginal = fileRes.ok ? String(fileRes.content ?? "") : "";
      const computed = applyLineDiffToOriginal(baseOriginal, selected.diff ?? "", selected.kind);
      setDiffState({
        loading: false,
        // Snapshot is optional for Codex reviews; always fall back to diff text if needed.
        error: undefined,
        original: computed.original,
        modified: computed.modified,
        truncated: false,
        isBinary: false
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, slot, threadId, turnId]);

  // Keep model URIs stable per tab to avoid Monaco disposing models during fast selection changes.
  const originalUri = `${MONACO_URI_SCHEME}:/__codex_review/${encodeURIComponent(tabId)}/original`;
  const modifiedUri = `${MONACO_URI_SCHEME}:/__codex_review/${encodeURIComponent(tabId)}/modified`;

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="w-[220px] shrink-0 border-r border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
        <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
          {t("files")} ({files.length})
        </div>
        <div className="h-[calc(100%-2rem)] overflow-auto p-1">
          {files.map((f) => {
            const active = selected?.path === f.path;
            const plus = Number(f.added ?? 0);
            const minus = Number(f.removed ?? 0);
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelectedPath(f.path)}
                className={[
                  "w-full rounded px-2 py-1 text-left",
                  active
                    ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                    : "hover:bg-[var(--vscode-list-hoverBackground)]"
                ].join(" ")}
                title={f.path}
              >
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 truncate text-[11px]">{f.path}</div>
                  <div className="shrink-0 tabular-nums text-[10px]">
                    {plus ? <span className="text-[color-mix(in_srgb,#89d185_90%,white)]">{`+${plus}`}</span> : null}
                    {minus ? (
                      <span className={["text-[color-mix(in_srgb,#f14c4c_90%,white)]", plus ? "ml-2" : ""].join(" ")}>
                        {`-${minus}`}
                      </span>
                    ) : null}
                    {!plus && !minus ? (
                      <span className={active ? "text-white/80" : "text-[var(--vscode-descriptionForeground)]"}>{formatCounts(0, 0) || "no changes"}</span>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="relative min-h-0 h-[calc(100%-2.25rem)]">
        <DiffEditor
            key={tabId}
            theme={MONACO_THEME_NAME}
            original={diffState.original}
            modified={diffState.modified}
            language={language}
            originalModelPath={originalUri}
            modifiedModelPath={modifiedUri}
            keepCurrentOriginalModel={true}
            keepCurrentModifiedModel={true}
            options={{
              readOnly: true,
              renderSideBySide: true,
              scrollBeyondLastLine: false,
              renderWhitespace: "selection",
              minimap: { enabled: false },
              automaticLayout: true
            }}
          />
          {diffState.loading ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-[var(--vscode-descriptionForeground)]">
              {t("loading")}
            </div>
          ) : null}
          {diffState.isBinary ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-[var(--vscode-descriptionForeground)]">
              Binary file diff is not supported.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
