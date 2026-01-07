import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcw, Save, Eye } from "lucide-react";
import { ensureMonacoLanguage, getMonacoThemeName } from "../monacoSetup";
import { classifyDiffLine, type DiffLineKind } from "../diffSupport";
import { languageFromPath, shouldEnableLsp } from "../languageSupport";
import { useI18n } from "./i18n";
import { useUiTheme } from "./UiThemeContext";

type Props = {
  slot: number;
  path: string;
  reveal?: { line: number; column: number; nonce: string };
  onDirtyChange?: (dirty: boolean) => void;
  rightExtras?: ReactNode;
};

loader.config({ monaco });

export default function FileEditor({ slot, path, reveal, onDirtyChange, rightExtras }: Props) {
  const { t } = useI18n();
  const { theme } = useUiTheme();
  const [value, setValue] = useState<string | null>(null);
  const valueRef = useRef<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const savingRef = useRef(false);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectionDisposableRef = useRef<monaco.IDisposable | null>(null);
  const lastRevealNonceRef = useRef<string | null>(null);
  const lspOpenRef = useRef<{ language: "python"; relPath: string } | null>(null);
  const lspChangeTimerRef = useRef<number | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const diffDecorationsTimerRef = useRef<number | null>(null);
  const diffDecorationIdsByUriRef = useRef<Map<string, string[]>>(new Map());
  const modelLifecycleDisposablesRef = useRef<monaco.IDisposable[]>([]);
  const lastDecoratedVersionIdRef = useRef<number>(-1);

  const language = useMemo(() => languageFromPath(path), [path]);
  const modelUri = useMemo(() => monaco.Uri.from({ scheme: "xcoding", path: `/${path}` }).toString(), [path]);
  const isLspLanguage = shouldEnableLsp(language);

  useEffect(() => {
    void ensureMonacoLanguage(language);
  }, [language]);

  const applyDiffDecorations = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel();
    if (!model) return;

    const uriKey = model.uri.toString();
    const oldIds = diffDecorationIdsByUriRef.current.get(uriKey) ?? [];
    const isDiff = model.getLanguageId() === "diff";

    if (!isDiff) {
      if (oldIds.length) diffDecorationIdsByUriRef.current.set(uriKey, model.deltaDecorations(oldIds, []));
      return;
    }

    const lineCount = model.getLineCount();
    const charCount = model.getValueLength();
    // Avoid jank on very large diffs.
    if (lineCount > 20_000 || charCount > 800_000) {
      if (oldIds.length) diffDecorationIdsByUriRef.current.set(uriKey, model.deltaDecorations(oldIds, []));
      return;
    }

    const versionId = model.getVersionId();
    if (lastDecoratedVersionIdRef.current === versionId) return;
    lastDecoratedVersionIdRef.current = versionId;

    // For medium-large diffs, avoid re-scanning on every edit: only decorate once unless content is reloaded.
    // Editing diffs is rare; this is a perf guardrail.
    if (lineCount > 5_000 && oldIds.length > 0) return;

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
      const kind = classifyDiffLine(model.getLineContent(lineNumber)) as DiffLineKind | null;
      if (!kind) continue;
      decorations.push({
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: { isWholeLine: true, className: `xcoding-diff-line-${kind}` }
      });
    }

    diffDecorationIdsByUriRef.current.set(uriKey, model.deltaDecorations(oldIds, decorations));
  }, []);

  const scheduleDiffDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    if (model.getLanguageId() !== "diff") return;
    if (diffDecorationsTimerRef.current) window.clearTimeout(diffDecorationsTimerRef.current);
    diffDecorationsTimerRef.current = window.setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          diffDecorationsTimerRef.current = null;
          try {
            applyDiffDecorations(editor);
          } catch {
            // ignore
          }
        });
      });
    }, 160);
  }, [applyDiffDecorations]);

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
    if (language === "diff") lastDecoratedVersionIdRef.current = -1;
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
      if (diffDecorationsTimerRef.current) window.clearTimeout(diffDecorationsTimerRef.current);
      diffDecorationsTimerRef.current = null;
      for (const d of modelLifecycleDisposablesRef.current) d.dispose();
      modelLifecycleDisposablesRef.current = [];
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
    const lspLanguage = "python";

    if (!lspOpenRef.current || lspOpenRef.current.relPath !== path || lspOpenRef.current.language !== lspLanguage) {
      lspOpenRef.current = { language: lspLanguage, relPath: path };
      void window.xcoding.project.lspDidOpen({ slot, language: lspLanguage, path, languageId: lspLanguage, content: value ?? "" });
      return;
    }
  }, [error, isLspLanguage, language, path, slot, value]);

  useEffect(() => {
    if (!isLspLanguage) return;
    if (error) return;
    if (!lspOpenRef.current || lspOpenRef.current.relPath !== path) return;
    if (lspChangeTimerRef.current) window.clearTimeout(lspChangeTimerRef.current);
    const lspLanguage = "python";
    lspChangeTimerRef.current = window.setTimeout(() => {
      void window.xcoding.project.lspDidChange({ slot, language: lspLanguage, path, content: value ?? "" });
    }, 250);
    return () => {
      if (lspChangeTimerRef.current) window.clearTimeout(lspChangeTimerRef.current);
    };
  }, [error, isLspLanguage, language, path, slot, value]);

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
    if (language !== "diff") return;
    scheduleDiffDecorations();
  }, [language, scheduleDiffDecorations, path, value]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2 py-1">
        <div className="min-w-0 truncate text-[11px] text-[var(--vscode-foreground)]">
          {path} {dirty ? <span className="text-amber-400">*</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error ? <div className="max-w-[220px] truncate text-[11px] text-[var(--color-token-error-foreground)]">{error}</div> : null}
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
            theme={getMonacoThemeName(theme)}
            keepCurrentModel
            value={value ?? ""}
            onMount={(editor) => {
              editorRef.current = editor;
              selectionDisposableRef.current?.dispose();
              scheduleDiffDecorations();
              for (const d of modelLifecycleDisposablesRef.current) d.dispose();
              modelLifecycleDisposablesRef.current = [];

              const model = editor.getModel();
              if (model) {
                lastDecoratedVersionIdRef.current = -1;
                const uriKey = model.uri.toString();
                modelLifecycleDisposablesRef.current.push(
                  model.onWillDispose(() => {
                    diffDecorationIdsByUriRef.current.delete(uriKey);
                  })
                );
              }
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
              fontFamily: '"FiraCode Nerd Font", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
              fontSize: 13,
              fontLigatures: true,
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
    </div>
  );
}
