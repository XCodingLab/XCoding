import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useRef } from "react";
import { ensureMonacoLanguage, MONACO_URI_SCHEME } from "../../../monacoSetup";
import { useUiTheme } from "../../../ui/UiThemeContext";

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

type Props = {
  slot: number;
  sessionId: string;
  absPath: string;
  loading: boolean;
  error?: string;
  original: string;
  modified: string;
};

export default function ClaudeFileDiffView({ slot, sessionId, absPath, loading, error, original, modified }: Props) {
  const { monacoThemeName } = useUiTheme();
  const language = useMemo(() => guessLanguageIdFromPath(absPath), [absPath]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void ensureMonacoLanguage(language).catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, [language]);

  // Keep model URIs stable per slot/session/path so switches don't churn models.
  const encoded = useMemo(() => encodeURIComponent(absPath).slice(0, 180), [absPath]);
  const base = `${MONACO_URI_SCHEME}:/__claude/${slot}/${encodeURIComponent(sessionId)}/${encoded}`;
  const originalUri = `${base}/original`;
  const modifiedUri = `${base}/modified`;

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <DiffEditor
        theme={monacoThemeName}
        original={original ?? ""}
        modified={modified ?? ""}
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
      {loading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-[var(--vscode-descriptionForeground)]">
          Loading…
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 text-[11px] text-[var(--vscode-errorForeground)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}

