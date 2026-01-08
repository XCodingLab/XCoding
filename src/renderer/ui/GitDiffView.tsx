import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureMonacoLanguage, monaco, MONACO_THEME_NAME, MONACO_URI_SCHEME } from "../monacoSetup";
import { useI18n } from "./i18n";

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

export default function GitDiffView({ slot, path, mode }: { slot: number; path: string; mode: "working" | "staged" }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ loading: boolean; error?: string; original: string; modified: string; truncated: boolean; isBinary: boolean }>({
    loading: true,
    original: "",
    modified: "",
    truncated: false,
    isBinary: false
  });
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved" | "error">("");
  const saveTimerRef = useRef<number | null>(null);
  const saveDisposableRef = useRef<monaco.IDisposable | null>(null);

  const language = useMemo(() => guessLanguageIdFromPath(path), [path]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      saveDisposableRef.current?.dispose();
      saveDisposableRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: undefined, truncated: false, isBinary: false }));
    void ensureMonacoLanguage(language)
      .catch(() => {})
      .then(async () => {
        const res = await window.xcoding.project.gitFileDiff({ slot, path, mode });
        if (cancelled) return;
        if (!res.ok) {
          setState({ loading: false, error: res.reason ?? "git_file_diff_failed", original: "", modified: "", truncated: false, isBinary: false });
          return;
        }
        setState({
          loading: false,
          error: undefined,
          original: res.original ?? "",
          modified: res.modified ?? "",
          truncated: Boolean(res.truncated),
          isBinary: Boolean(res.isBinary)
        });
      });
    return () => {
      cancelled = true;
    };
  }, [language, mode, path, slot]);

  const header = (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2 py-2 text-[11px] text-[var(--vscode-foreground)]">
      <div className="min-w-0 truncate">
        <span className="font-semibold">Diff:</span> {path}
        <span className="ml-2 text-[var(--vscode-descriptionForeground)]">({mode === "staged" ? "staged" : "working"})</span>
      </div>
      <div className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">
        {state.truncated ? t("truncated") : saveStatus === "saving" ? t("saving") : saveStatus === "saved" ? t("saved") : saveStatus === "error" ? t("saveFailed") : ""}
      </div>
    </div>
  );

  // Keep model URIs stable per slot+mode so fast switches don't dispose models mid-reset.
  const originalUri = `${MONACO_URI_SCHEME}:/__git/${mode}/${slot}/original`;
  const modifiedUri = `${MONACO_URI_SCHEME}:/__git/${mode}/${slot}/modified`;

  const canEdit = mode === "working" && !state.truncated && !state.isBinary;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      {header}
      <div className="relative min-h-0 flex-1">
        <DiffEditor
          theme={MONACO_THEME_NAME}
          original={state.original ?? ""}
          modified={state.modified ?? ""}
          language={language}
          originalModelPath={originalUri}
          modifiedModelPath={modifiedUri}
          keepCurrentOriginalModel={true}
          keepCurrentModifiedModel={true}
          onMount={(editor) => {
            // onMount doesn't support returning cleanup; manage it via refs.
            if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
            saveDisposableRef.current?.dispose();
            saveDisposableRef.current = null;

            // Only allow editing the "modified" side in Review working mode.
            const modifiedEditor = editor.getModifiedEditor();
            const model = modifiedEditor.getModel();
            if (!model) return;

            // Keep editor read-only state in sync (DiffEditor options sometimes lag on first mount).
            try {
              modifiedEditor.updateOptions({ readOnly: !canEdit });
            } catch {
              // ignore
            }

            if (!canEdit) return;

            saveDisposableRef.current = model.onDidChangeContent(() => {
              if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
              setSaveStatus("saving");
              saveTimerRef.current = window.setTimeout(async () => {
                saveTimerRef.current = null;
                try {
                  const next = model.getValue();
                  const res = await window.xcoding.project.writeFile({ slot, path, content: next });
                  if (!res.ok) {
                    setSaveStatus("error");
                    return;
                  }
                  setSaveStatus("saved");
                  window.setTimeout(() => setSaveStatus(""), 1200);
                } catch {
                  setSaveStatus("error");
                }
              }, 450);
            });
          }}
          options={{
            readOnly: !canEdit,
            renderSideBySide: true,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            minimap: { enabled: false },
            automaticLayout: true
          }}
        />
        {state.loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-[var(--vscode-descriptionForeground)]">
            {t("loading")}
          </div>
        ) : null}
        {state.error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-red-400">{state.error}</div>
        ) : null}
        {state.isBinary ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-[var(--vscode-descriptionForeground)]">
            Binary file diff is not supported.
          </div>
        ) : null}
      </div>
    </div>
  );
}
