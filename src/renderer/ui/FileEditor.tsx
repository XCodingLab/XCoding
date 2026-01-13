import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { ensureMonacoLanguage } from "../monacoSetup";
import { classifyDiffLine, type DiffLineKind } from "../diffSupport";
import { languageFromPath, shouldEnableLsp } from "../languageSupport";
import { useWorkingCopy } from "../editor/workingCopy/useWorkingCopy";
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
  const { monacoThemeName } = useUiTheme();
  const { workingCopy, snapshot } = useWorkingCopy(slot, path);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const lastReportedDirtyRef = useRef<boolean | null>(null);
  const selectionDisposableRef = useRef<monaco.IDisposable | null>(null);
  const lastRevealNonceRef = useRef<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const diffDecorationsTimerRef = useRef<number | null>(null);
  const diffDecorationIdsByUriRef = useRef<Map<string, string[]>>(new Map());
  const modelLifecycleDisposablesRef = useRef<monaco.IDisposable[]>([]);
  const lastDecoratedVersionIdRef = useRef<number>(-1);

  const language = useMemo(() => languageFromPath(path), [path]);
  const modelUri = useMemo(() => monaco.Uri.from({ scheme: "xcoding", path: `/${path}` }).toString(), [path]);
  const isLspLanguage = shouldEnableLsp(language);
  const lspServerLanguage = useMemo(() => {
    if (!isLspLanguage) return null;
    if (language === "python") return "python" as const;
    if (language === "go") return "go" as const;
    if (language === "typescript" || language === "javascript") return "typescript" as const;
    return null;
  }, [isLspLanguage, language]);
  const dirty = Boolean(snapshot?.dirty);
  const error = snapshot?.error ?? null;
  const conflict = Boolean(snapshot?.conflict);
  const orphaned = Boolean(snapshot?.orphaned);
  const isBinary = Boolean(snapshot?.isBinary);
  const truncated = Boolean(snapshot?.truncated);
  const isLoading = snapshot ? snapshot.isLoading || !snapshot.isResolved : true;
  const isUnsupported = isBinary || truncated;

  useEffect(() => {
    void ensureMonacoLanguage(language);
  }, [language]);

  useEffect(() => {
    // `onDirtyChange` is usually an inline callback that triggers state updates in the parent.
    // Only report when `dirty` actually changes to avoid render loops.
    if (lastReportedDirtyRef.current === dirty) return;
    lastReportedDirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

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
    if (!lspServerLanguage) return;
    if (!workingCopy || !snapshot) return;
    if (!snapshot.isResolved || snapshot.error) return;
    if (snapshot.isBinary || snapshot.truncated) return;
    const model = workingCopy.getModel();
    const lspLanguage = lspServerLanguage;

    let changeTimer: number | null = null;
    void window.xcoding.project.lspDidOpen({ slot, language: lspLanguage, path, languageId: language, content: model.getValue() });
    const disposable = model.onDidChangeContent(() => {
      if (changeTimer != null) window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => {
        changeTimer = null;
        void window.xcoding.project.lspDidChange({ slot, language: lspLanguage, path, content: model.getValue() });
      }, 250);
    });

    return () => {
      if (changeTimer != null) window.clearTimeout(changeTimer);
      disposable.dispose();
      void window.xcoding.project.lspDidClose({ slot, language: lspLanguage, path });
    };
  }, [language, lspServerLanguage, path, slot, snapshot?.error, snapshot?.isResolved, snapshot?.isBinary, snapshot?.truncated, workingCopy]);

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
      if (!workingCopy) return;
      if (isLoading || isUnsupported) return;
      void workingCopy.save();
    };
    window.addEventListener("xcoding:requestSaveFile", handler as any);
    return () => window.removeEventListener("xcoding:requestSaveFile", handler as any);
  }, [isLoading, isUnsupported, path, slot, workingCopy]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slot?: number; path?: string; command?: string } | undefined;
      if (!detail) return;
      if (detail.slot !== slot) return;
      if (detail.path !== path) return;
      if (isUnsupported || isLoading) return;
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      const command = String(detail.command ?? "");
      if (command === "find") editor.trigger("keyboard", "actions.find", null);
      if (command === "replace") editor.trigger("keyboard", "editor.action.startFindReplaceAction", null);
      if (command === "gotoDefinition") editor.trigger("keyboard", "editor.action.revealDefinition", null);
    };
    window.addEventListener("xcoding:requestEditorCommand", handler as any);
    return () => window.removeEventListener("xcoding:requestEditorCommand", handler as any);
  }, [isLoading, isUnsupported, path, slot]);

  useEffect(() => {
    if (language !== "diff") return;
    lastDecoratedVersionIdRef.current = -1;
    scheduleDiffDecorations();
  }, [language, scheduleDiffDecorations, path, snapshot?.mtimeMs]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-2 py-1">
        <div className="min-w-0 truncate text-[11px] text-[var(--vscode-foreground)]">
          {path} {dirty ? <span className="text-amber-400">*</span> : null}
          {orphaned ? <span className="ml-1 text-red-400">[{t("deleted")}]</span> : null}
          {conflict ? <span className="ml-1 text-amber-400">[{t("diskChanged")}]</span> : null}
          {isBinary ? <span className="ml-1 text-[var(--vscode-descriptionForeground)]">[{t("binaryFile")}]</span> : null}
          {truncated ? <span className="ml-1 text-[var(--vscode-descriptionForeground)]">[{t("fileTooLarge")}]</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error ? <div className="max-w-[220px] truncate text-[11px] text-red-400">{error}</div> : null}
          {conflict && workingCopy && !isLoading && !isUnsupported ? (
            <button
              className="flex items-center gap-1 rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-0.5 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              type="button"
              onClick={() => {
                if (!window.confirm(t("reloadDiscardConfirm"))) return;
                void workingCopy.resolveFromDisk("reload");
              }}
              title={t("reloadDiscardConfirm")}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {rightExtras}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loadingEditor")}</div>
        ) : isUnsupported ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-[var(--vscode-descriptionForeground)]">
            <div className="text-[13px] font-semibold text-[var(--vscode-foreground)]">{t("unsupportedFileTitle")}</div>
            <div className="max-w-[520px]">
              {isBinary ? t("unsupportedBinaryHint") : t("unsupportedLargeHint")}
              {snapshot?.size ? <div className="mt-1">{t("fileSize")}: {Math.max(0, Number(snapshot.size))} bytes</div> : null}
            </div>
          </div>
        ) : (
          <Editor
            key={modelUri}
            height="100%"
            path={modelUri}
            language={language}
            theme={monacoThemeName}
            keepCurrentModel
            defaultValue=""
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
              if (language === "diff") scheduleDiffDecorations();
              if (language !== "markdown") return;
              if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
              const payload = { slot, path, content: next ?? "" };
              previewTimerRef.current = window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent("xcoding:fileContentChanged", { detail: payload }));
              }, 120);
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
