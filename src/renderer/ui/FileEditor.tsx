import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcw, Save, Eye } from "lucide-react";
import { MONACO_THEME_NAME } from "../monacoSetup";
import { useI18n } from "./i18n";

type Props = {
  slot: number;
  path: string;
  reveal?: { line: number; column: number; nonce: string };
  onDirtyChange?: (dirty: boolean) => void;
  rightExtras?: ReactNode;
};

loader.config({ monaco });

function languageFromPath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  return "plaintext";
}

export default function FileEditor({ slot, path, reveal, onDirtyChange, rightExtras }: Props) {
  const { t } = useI18n();
  const [value, setValue] = useState<string | null>(null);
  const valueRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Array<{ code: number; message: string; line: number; column: number; category: string }>>(
    []
  );
  const savingRef = useRef(false);
  const diagTimerRef = useRef<number | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectionDisposableRef = useRef<monaco.IDisposable | null>(null);
  const lastRevealNonceRef = useRef<string | null>(null);
  const lspOpenRef = useRef<{ language: "python" | "go"; relPath: string } | null>(null);
  const lspChangeTimerRef = useRef<number | null>(null);
  const lspDiagnosticsOwnerRef = useRef<string>("lsp");
  const previewTimerRef = useRef<number | null>(null);

  const language = useMemo(() => languageFromPath(path), [path]);
  const modelUri = useMemo(() => monaco.Uri.from({ scheme: "xcoding", path: `/${path}` }).toString(), [path]);
  const isLspLanguage = language === "python" || language === "go";

  async function load() {
    const res = await window.xcoding.project.readFile({ slot, path });
    if (!res.ok) {
      setError(res.reason ?? "read_failed");
      setValue("");
      valueRef.current = "";
      setDirty(false);
      onDirtyChange?.(false);
      return;
    }
    setError(null);
    const content = res.content ?? "";
    setValue(content);
    valueRef.current = content;
    setDirty(false);
    onDirtyChange?.(false);
    setDiagnostics([]);
  }

  async function save() {
    if (savingRef.current) return;
    if (value === null) return; // still loading
    savingRef.current = true;
    const res = await window.xcoding.project.writeFile({ slot, path, content: valueRef.current });
    savingRef.current = false;
    if (!res.ok) {
      setError(res.reason ?? "save_failed");
      window.dispatchEvent(new CustomEvent("xcoding:fileSaveResult", { detail: { slot, path, ok: false, reason: res.reason ?? "save_failed" } }));
      return;
    }
    setError(null);
    setDirty(false);
    onDirtyChange?.(false);
    window.dispatchEvent(new CustomEvent("xcoding:fileSaveResult", { detail: { slot, path, ok: true } }));
  }

  useEffect(() => {
    setValue(null);
    setDirty(false);
    onDirtyChange?.(false);
    void load();
  }, [slot, path]);

  useEffect(() => {
    return () => {
      if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      selectionDisposableRef.current?.dispose();
      selectionDisposableRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    if (!isLspLanguage) return;
    if (value === null && !error) return;
    if (error) return;
    const lspLanguage = language as "python" | "go";

    if (!lspOpenRef.current || lspOpenRef.current.relPath !== path || lspOpenRef.current.language !== lspLanguage) {
      lspOpenRef.current = { language: lspLanguage, relPath: path };
      lspDiagnosticsOwnerRef.current = `lsp:${lspLanguage}`;
      void window.xcoding.project.lspDidOpen({ slot, language: lspLanguage, path, languageId: lspLanguage, content: value ?? "" });
      return;
    }
  }, [error, isLspLanguage, language, path, slot, value]);

  useEffect(() => {
    if (!isLspLanguage) return;
    if (error) return;
    if (!lspOpenRef.current || lspOpenRef.current.relPath !== path) return;
    if (lspChangeTimerRef.current) window.clearTimeout(lspChangeTimerRef.current);
    const lspLanguage = language as "python" | "go";
    lspChangeTimerRef.current = window.setTimeout(() => {
      void window.xcoding.project.lspDidChange({ slot, language: lspLanguage, path, content: value ?? "" });
    }, 250);
    return () => {
      if (lspChangeTimerRef.current) window.clearTimeout(lspChangeTimerRef.current);
    };
  }, [error, isLspLanguage, language, path, slot, value]);

  useEffect(() => {
    const dispose = window.xcoding.events.onProjectEvent((evt) => {
      if (evt.type !== "lsp:diagnostics") return;
      const rel = String((evt as any).relativePath ?? "");
      if (rel !== path) return;
      const diagnostics = Array.isArray((evt as any).diagnostics) ? ((evt as any).diagnostics as any[]) : [];
      const model = editorRef.current?.getModel();
      if (!model) return;
      const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => ({
        startLineNumber: Math.max(1, Number(d.range?.start?.line ?? 0) + 1),
        startColumn: Math.max(1, Number(d.range?.start?.character ?? 0) + 1),
        endLineNumber: Math.max(1, Number(d.range?.end?.line ?? 0) + 1),
        endColumn: Math.max(1, Number(d.range?.end?.character ?? 0) + 1),
        message: String(d.message ?? ""),
        severity:
          Number(d.severity ?? 1) === 1
            ? monaco.MarkerSeverity.Error
            : Number(d.severity ?? 1) === 2
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        code: d.code ? String(d.code) : undefined,
        source: "LSP"
      }));
      monaco.editor.setModelMarkers(model, lspDiagnosticsOwnerRef.current, markers);
    });
    return () => dispose();
  }, [path]);

  useEffect(() => {
    return () => {
      const open = lspOpenRef.current;
      if (open && open.relPath === path) {
        void window.xcoding.project.lspDidClose({ slot, language: open.language, path: open.relPath });
      }
      lspOpenRef.current = null;
    };
  }, [path, slot]);

  useEffect(() => {
    const revealNonce = reveal?.nonce ?? null;
    if (!revealNonce) return;
    if (lastRevealNonceRef.current === revealNonce) return;
    const editor = editorRef.current;
    if (!editor) return;
    const line = Math.max(1, reveal?.line ?? 1);
    const column = Math.max(1, reveal?.column ?? 1);
    lastRevealNonceRef.current = revealNonce;
    try {
      editor.revealPositionInCenter({ lineNumber: line, column });
      editor.setPosition({ lineNumber: line, column });
      editor.setSelection(new monaco.Selection(line, column, line, column));
      editor.focus();
    } catch {
      // ignore
    }
  }, [reveal?.nonce, reveal?.line, reveal?.column]);

  useEffect(() => {
    // Bridge for global shortcuts handled at App level (Cmd/Ctrl+S).
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slot?: number; path?: string } | undefined;
      if (!detail) return;
      if (detail.slot !== slot) return;
      if (detail.path !== path) return;
      void save();
    };
    window.addEventListener("xcoding:requestSaveFile", handler as any);
    return () => window.removeEventListener("xcoding:requestSaveFile", handler as any);
  }, [slot, path, value]);

  useEffect(() => {
    const lower = path.toLowerCase();
    const shouldDiag = lower.endsWith(".ts") || lower.endsWith(".tsx");
    if (!shouldDiag) {
      setDiagnostics([]);
      return;
    }
    if (value === null) return;
    if (diagTimerRef.current) window.clearTimeout(diagTimerRef.current);
    diagTimerRef.current = window.setTimeout(() => {
      void window.xcoding.project.tsDiagnostics({ slot, path, content: value }).then((res) => {
        if (!res.ok) return;
        setDiagnostics(res.diagnostics ?? []);
      });
    }, 300);
    return () => {
      if (diagTimerRef.current) window.clearTimeout(diagTimerRef.current);
    };
  }, [slot, path, value]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2 py-1">
        <div className="min-w-0 truncate text-[11px] text-[var(--vscode-foreground)]">
          {path} {dirty ? <span className="text-amber-400">*</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error ? <div className="max-w-[220px] truncate text-[11px] text-red-400">{error}</div> : null}
          <button
            className="flex items-center gap-1 rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-0.5 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
            disabled={!dirty}
            onClick={() => void save()}
            type="button"
            title={t("save")}
          >
            <Save className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex items-center gap-1 rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-0.5 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            onClick={() => void load()}
            type="button"
            title={t("reload")}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          {rightExtras}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {value === null ? (
          <div className="flex h-full items-center justify-center text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loadingEditor")}</div>
        ) : (
          <Editor
            height="100%"
            path={modelUri}
            language={language}
            theme={MONACO_THEME_NAME}
            keepCurrentModel
            value={value ?? ""}
            onMount={(editor) => {
              editorRef.current = editor;
              selectionDisposableRef.current?.dispose();
            const emitSelection = () => {
              const model = editor.getModel();
              if (!model) return;
              const selection = editor.getSelection();
              const selections = editor.getSelections() ?? [];

              const activeSelectionContent = selection ? model.getValueInRange(selection) : "";
              const toPos = (lineNumber: number, column: number) => ({ line: Math.max(0, lineNumber - 1), character: Math.max(0, column - 1) });
              const primary =
                selection
                  ? { start: toPos(selection.startLineNumber, selection.startColumn), end: toPos(selection.endLineNumber, selection.endColumn) }
                  : null;
              const allSelections = selections.map((s) => ({
                start: toPos(s.startLineNumber, s.startColumn),
                end: toPos(s.endLineNumber, s.endColumn)
              }));

              window.dispatchEvent(
                new CustomEvent("xcoding:fileSelectionChanged", {
                  detail: {
                    slot,
                    path,
                    selection: primary,
                    selections: allSelections,
                    activeSelectionContent
                  }
                })
              );
            };

            selectionDisposableRef.current = editor.onDidChangeCursorSelection(() => emitSelection());
            emitSelection();

          }}
          loading={<div className="p-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loadingEditor")}</div>}
            onChange={(next) => {
              if (next === undefined) return; // ignore dispose events so we don't wipe the buffer
              valueRef.current = next;
              setValue(next);
              if (!dirty) {
                setDirty(true);
                onDirtyChange?.(true);
              }
              if (language === "markdown") {
                if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
                const payload = { slot, path, content: next ?? "" };
                previewTimerRef.current = window.setTimeout(() => {
                  window.dispatchEvent(new CustomEvent("xcoding:fileContentChanged", { detail: payload }));
                }, 120);
              }
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              tabSize: 2,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              unicodeHighlight: {
                ambiguousCharacters: false,
                invisibleCharacters: false
              }
            }}
          />
        )}
      </div>
      {diagnostics.length ? (
        <div className="max-h-28 overflow-auto border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2 py-1 text-[11px] text-[var(--vscode-foreground)]">
          <div className="mb-1 text-[10px] text-[var(--vscode-descriptionForeground)]">{t("diagnosticsSyntax")}</div>
          {diagnostics.slice(0, 20).map((d) => (
            <div key={`${d.code}-${d.line}-${d.column}-${d.message}`} className="truncate">
              <span className="text-[var(--vscode-descriptionForeground)]">
                {d.line}:{d.column}
              </span>{" "}
              <span className={d.category === "Error" ? "text-red-400" : "text-amber-400"}>{d.category}</span>{" "}
              <span className="text-[var(--vscode-foreground)]">{d.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
