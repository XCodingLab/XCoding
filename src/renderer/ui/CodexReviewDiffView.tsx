import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { ensureMonacoLanguage, MONACO_URI_SCHEME } from "../monacoSetup";
import { useUiTheme } from "./UiThemeContext";
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

function countTextLines(text: string) {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  if (!t) return 0;
  const parts = t.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
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
  if (k === "add" || k === "create" || k === "new" || k === "added") return true;
  if (k === "addfile" || k === "createfile" || k === "newfile") return true;
  if (k.includes("add") && k.includes("file")) return true;
  if (k.includes("create") && k.includes("file")) return true;
  if (k.includes("new") && k.includes("file")) return true;
  return false;
}

function isDeleteKind(kind?: string) {
  const k = normalizeKind(kind);
  if (!k) return false;
  if (k === "delete" || k === "remove" || k === "rm" || k === "del" || k === "deleted" || k === "removed") return true;
  if (k === "deletefile" || k === "removefile" || k === "deletedfile") return true;
  if (k.includes("delete") && k.includes("file")) return true;
  if (k.includes("remove") && k.includes("file")) return true;
  return false;
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

  if (isAddKind(kind)) return { original: "", modified: modified.join("\n") };
  if (isDeleteKind(kind)) return { original: original.join("\n"), modified: "" };
  return { original: original.join("\n"), modified: modified.join("\n") };
}

function stripMetaAndHunks(diffText: string) {
  const raw = String(diffText ?? "").replace(/\r\n/g, "\n");
  return raw
    .split("\n")
    .map((l) => l.replace(/^\uFEFF/, ""))
    .filter((l) => l && !isMetaLine(l) && !l.startsWith("@@"));
}

function reverseDiffText(diffText: string) {
  const raw = String(diffText ?? "").replace(/\r\n/g, "\n");
  return raw
    .split("\n")
    .map((line) => {
      if (!line) return line;
      if (line.startsWith("+++ ") || line.startsWith("--- ")) return line;
      if (line.startsWith("+")) return `-${line.slice(1)}`;
      if (line.startsWith("-")) return `+${line.slice(1)}`;
      return line;
    })
    .join("\n");
}

function applyLineDiffToOriginal(originalText: string, diffText: string, kind?: string) {
  if (isAddKind(kind)) {
    return toOriginalAndModified(diffText, kind);
  }
  if (isDeleteKind(kind)) return { original: originalText, modified: "" };

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
  const { monacoThemeName } = useUiTheme();
  const [selectedPath, setSelectedPath] = useState("");
  const [countsByPath, setCountsByPath] = useState<Record<string, { added: number; removed: number }>>({});
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
    let cancelled = false;
    setCountsByPath({});
    const targets = files.filter((f) => {
      const plus = Number(f.added ?? 0);
      const minus = Number(f.removed ?? 0);
      if (isAddKind(f.kind) && plus === 0) return true;
      if (isDeleteKind(f.kind) && minus === 0) return true;
      return false;
    });
    if (!targets.length) return () => {};

    void (async () => {
      const pairs = await Promise.all(
        targets.map(async (f) => {
          const compute = (originalText: string, modifiedText: string) => {
            if (isAddKind(f.kind)) return { path: f.path, added: countTextLines(modifiedText), removed: 0 };
            if (isDeleteKind(f.kind)) return { path: f.path, added: 0, removed: countTextLines(originalText) };
            return null;
          };

          const res = await window.xcoding.codex.turnFileDiff({ threadId, turnId, path: f.path });
          if (res.ok && !res.isBinary && !res.truncated) {
            const computed = compute(res.original, res.modified);
            const needsGitFallback = (isDeleteKind(f.kind) && !String(res.original ?? "").trim()) || (isAddKind(f.kind) && !String(res.modified ?? "").trim());
            if (computed && !needsGitFallback) return computed;
          }

          const gitRes = await window.xcoding.project.gitFileDiff({ slot, path: f.path, mode: "working" });
          if (gitRes.ok && !gitRes.isBinary && !gitRes.truncated) return compute(String(gitRes.original ?? ""), String(gitRes.modified ?? ""));

          return null;
        })
      );
      if (cancelled) return;
      const next: Record<string, { added: number; removed: number }> = {};
      for (const p of pairs) {
        if (!p) continue;
        next[p.path] = { added: p.added, removed: p.removed };
      }
      setCountsByPath(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [files, slot, threadId, turnId]);

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
        const kind = selected.kind;
        if (res.isBinary) {
          setDiffState({ loading: false, error: undefined, original: "", modified: "", truncated: false, isBinary: true });
          return;
        }

        let original = res.original ?? "";
        let modified = res.modified ?? "";
        let truncated = Boolean(res.truncated);

        if (isDeleteKind(kind)) {
          // During running turns the file may still exist on disk; force a delete-style diff.
          modified = "";
          if (!original.trim()) {
            const gitRes = await window.xcoding.project.gitFileDiff({ slot, path: selected.path, mode: "working" });
            if (gitRes.ok && !gitRes.isBinary) {
              original = String(gitRes.original ?? "");
              truncated = truncated || Boolean(gitRes.truncated);
            }
          }
        } else if (isAddKind(kind)) {
          original = "";
          // During running turns the file may not exist yet; reconstruct from diff text if possible.
          if (!modified.trim()) {
            const computed = applyLineDiffToOriginal("", selected.diff ?? "", kind);
            if (computed.modified) modified = computed.modified;
          }
          // If we reconstructed from diff, it is not truncated.
          if (modified && !res.modified?.trim()) truncated = false;
        }

        setDiffState({
          loading: false,
          error: undefined,
          original,
          modified,
          truncated,
          isBinary: false
        });
        return;
      }

      const fileRes = await window.xcoding.project.readFile({ slot, path: selected.path });
      if (cancelled) return;
      const isAdd = isAddKind(selected.kind);
      const isDelete = isDeleteKind(selected.kind);
      const modifiedText = fileRes.ok ? String(fileRes.content ?? "") : "";

      if (fileRes.ok && fileRes.isBinary) {
        setDiffState({ loading: false, error: undefined, original: "", modified: "", truncated: false, isBinary: true });
        return;
      }

      if (isAdd) {
        const computed = applyLineDiffToOriginal("", selected.diff ?? "", selected.kind);
        let modified = fileRes.ok ? modifiedText : computed.modified;
        let truncated = Boolean(fileRes.ok ? fileRes.truncated : false);
        if (!fileRes.ok && !modified.trim()) {
          const gitRes = await window.xcoding.project.gitFileDiff({ slot, path: selected.path, mode: "working" });
          if (gitRes.ok && !gitRes.isBinary) {
            modified = String(gitRes.modified ?? "") || modified;
            truncated = truncated || Boolean(gitRes.truncated);
          }
        }
        setDiffState({
          loading: false,
          error: undefined,
          original: "",
          modified,
          truncated,
          isBinary: false
        });
        return;
      }

      if (isDelete) {
        let original = "";
        let truncated = false;
        if (fileRes.ok) {
          original = modifiedText;
          truncated = Boolean(fileRes.truncated);
        } else {
          const computed = toOriginalAndModified(selected.diff ?? "", selected.kind);
          original = computed.original;
          if (!original.trim()) {
            const gitRes = await window.xcoding.project.gitFileDiff({ slot, path: selected.path, mode: "working" });
            if (gitRes.ok && !gitRes.isBinary) {
              original = String(gitRes.original ?? "");
              truncated = truncated || Boolean(gitRes.truncated);
            }
          }
        }
        setDiffState({
          loading: false,
          error: undefined,
          original,
          modified: "",
          truncated,
          isBinary: false
        });
        return;
      }

      const computed = fileRes.ok
        ? (() => {
          const reversed = reverseDiffText(selected.diff ?? "");
          const reconstructedOriginal = applyLineDiffToOriginal(modifiedText, reversed, "updatefile");
          return { original: reconstructedOriginal.modified, modified: modifiedText, truncated: Boolean(fileRes.truncated) };
        })()
        : toOriginalAndModified(selected.diff ?? "", selected.kind);
      setDiffState({
        loading: false,
        // Snapshot is optional for Codex reviews; always fall back to diff text if needed.
        error: undefined,
        original: computed.original,
        modified: computed.modified,
        truncated: Boolean((computed as any).truncated ?? false),
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
            const override = countsByPath[f.path];
            const plus = Number(override?.added ?? f.added ?? 0);
            const minus = Number(override?.removed ?? f.removed ?? 0);
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
	            theme={monacoThemeName}
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
