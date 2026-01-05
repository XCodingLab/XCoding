import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MONACO_THEME_NAME } from "../monacoSetup";

loader.config({ monaco });

type Props = {
  slot: number;
  path: string | null;
  line?: number;
  query?: string;
  matchCase?: boolean;
  regex?: boolean;
};

export default function SearchPreviewPanel({ slot, path, line, query, matchCase = false, regex = false }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!path) {
      setContent(null);
      return;
    }
    setIsLoading(true);
    window.xcoding.project
      .readFile({ slot, path })
      .then((res) => {
        if (!res.ok) {
          setContent(null);
          return;
        }
        setContent(res.content ?? "");
      })
      .finally(() => setIsLoading(false));
  }, [path, slot]);

  const applyHighlights = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor, delay = false) => {
      const doApply = () => {
        const model = editor.getModel();
        if (!model) return;

        const decorations: monaco.editor.IModelDeltaDecoration[] = [];
        if (line) {
          decorations.push({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: "xcoding-search-preview-line",
              glyphMarginClassName: "xcoding-search-preview-glyph"
            }
          });
        }

        if (query) {
          let matches: monaco.editor.FindMatch[] = [];
          try {
            matches = model.findMatches(query, false, regex, matchCase, null, true);
          } catch {
            matches = [];
          }
          for (const m of matches) {
            decorations.push({ range: m.range, options: { inlineClassName: "xcoding-search-preview-text" } });
          }
        }

        decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
        if (line) editor.revealLineInCenter(line);
      };

      if (delay) requestAnimationFrame(() => requestAnimationFrame(doApply));
      else doApply();
    },
    [line, matchCase, query, regex]
  );

  useEffect(() => {
    if (!editorRef.current) return;
    applyHighlights(editorRef.current, true);
  }, [applyHighlights, content, line]);

  const language = useMemo(() => {
    if (!path) return "plaintext";
    const lower = path.toLowerCase();
    if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
    if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "css";
    if (lower.endsWith(".html")) return "html";
    if (lower.endsWith(".md")) return "markdown";
    if (lower.endsWith(".toml")) return "plaintext";
    if (lower.endsWith(".go")) return "go";
    if (lower.endsWith(".py")) return "python";
    return "plaintext";
  }, [path]);

  const modelUri = useMemo(() => {
    if (!path) return undefined;
    return monaco.Uri.from({ scheme: "xcoding", path: `/${path}` }).toString();
  }, [path]);

  if (!path) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">Select a result to preview</div>;
  }

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">Loading…</div>;
  }

  if (content === null) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">Unable to load file</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBarSectionHeader-background)] px-2 text-[11px] text-[var(--vscode-foreground)]">
        <span className="truncate">{path}</span>
        {line ? <span className="shrink-0 text-[var(--vscode-descriptionForeground)]">:{line}</span> : null}
      </div>

      <div className="min-h-0 flex-1">
        <Editor
          path={modelUri}
          value={content}
          language={language}
          theme={MONACO_THEME_NAME}
          onMount={(editor) => {
            editorRef.current = editor;
            applyHighlights(editor, true);
          }}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            lineNumbers: "on",
            folding: false,
            scrollBeyondLastLine: false,
            renderLineHighlight: "line",
            overviewRulerBorder: false,
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            fontSize: 12,
            wordWrap: "on",
            contextmenu: false,
            selectOnLineNumbers: false,
            glyphMargin: true
          }}
        />
      </div>

      <style>{`
        .xcoding-search-preview-line { background-color: rgba(255, 255, 0, 0.12) !important; }
        .xcoding-search-preview-text { background-color: rgba(255, 200, 0, 0.35) !important; border-radius: 2px; }
        .xcoding-search-preview-glyph { background-color: #ffc800; width: 4px !important; margin-left: 3px; border-radius: 2px; }
      `}</style>
    </div>
  );
}
