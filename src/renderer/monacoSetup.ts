import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

export const MONACO_THEME_NAME = "xcoding-dark";
export const MONACO_URI_SCHEME = "xcoding";

// Configure @monaco-editor/react to use our monaco instance.
loader.config({ monaco });

// Define a Monaco theme aligned with our VS Code-like CSS tokens in `src/renderer/styles.css`.
monaco.editor.defineTheme(MONACO_THEME_NAME, {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#cccccc",
    "editorCursor.foreground": "#cccccc",
    "editorLineNumber.foreground": "#9d9d9d",
    "editorLineNumber.activeForeground": "#cccccc",
    "editor.selectionBackground": "#094771",
    "editor.lineHighlightBackground": "#2a2a2a",
    "editorIndentGuide.background": "#2a2a2a",
    "editorIndentGuide.activeBackground": "#3c3c3c"
  }
});

try {
  monaco.editor.setTheme(MONACO_THEME_NAME);
} catch {
  // ignore
}

// Configure TypeScript/JavaScript defaults to reduce noisy project-wide resolution errors.
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  allowNonTsExtensions: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  noResolve: true
});

monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  allowNonTsExtensions: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  noResolve: true
});

monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
});

monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false
});

// Preload a small set of languages so tokenizers and workers are ready on first open.
const preloadLanguages = ["typescript", "javascript", "json", "markdown", "css", "html", "python", "go"];
for (const lang of preloadLanguages) {
  try {
    const model = monaco.editor.createModel("", lang);
    model.dispose();
  } catch {
    // ignore unsupported languages
  }
}

export { monaco };

function uriToRelPath(resource: monaco.Uri): string | null {
  if (resource.scheme !== MONACO_URI_SCHEME) return null;
  const p = resource.path || "";
  return p.replace(/^\/+/, "");
}

monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    const relPath = uriToRelPath(resource);
    if (!relPath) return false;
    const pos =
      selectionOrPosition && "startLineNumber" in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
        : selectionOrPosition && "lineNumber" in selectionOrPosition
          ? { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
          : null;
    window.dispatchEvent(new CustomEvent("xcoding:openFile", { detail: { relPath, line: pos?.line, column: pos?.column } }));
    return true;
  }
});

function getActiveSlot(): number {
  const slot = Number((window as any).__xcodingActiveSlot ?? 1);
  return Number.isFinite(slot) && slot > 0 ? slot : 1;
}

function getActiveProjectRoot(): string {
  return String((window as any).__xcodingActiveProjectRoot ?? "");
}

function fileUriToRelPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith(`${MONACO_URI_SCHEME}:/`)) {
    try {
      const u = monaco.Uri.parse(uri);
      return uriToRelPath(u);
    } catch {
      return null;
    }
  }

  if (!uri.startsWith("file://")) return null;
  try {
    const u = new URL(uri);
    const absPath = decodeURIComponent(u.pathname);
    const root = getActiveProjectRoot();
    if (!root) return null;
    const normalizedRoot = root.replace(/[\\\\]+/g, "/").replace(/\/+$/, "");
    const normalizedAbs = absPath.replace(/[\\\\]+/g, "/");
    if (!normalizedAbs.startsWith(normalizedRoot)) return null;
    const rel = normalizedAbs.slice(normalizedRoot.length).replace(/^\/+/, "");
    return rel || null;
  } catch {
    return null;
  }
}

function toLspPosition(pos: monaco.Position) {
  return { line: Math.max(0, pos.lineNumber - 1), character: Math.max(0, pos.column - 1) };
}

function toMonacoRange(range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | null) {
  if (!range) return undefined;
  const startLine = Math.max(1, Number(range.start?.line ?? 0) + 1);
  const startCol = Math.max(1, Number(range.start?.character ?? 0) + 1);
  const endLine = Math.max(1, Number(range.end?.line ?? 0) + 1);
  const endCol = Math.max(1, Number(range.end?.character ?? 0) + 1);
  return new monaco.Range(startLine, startCol, endLine, endCol);
}

async function lspRequest(language: "python" | "go", relPath: string, method: string, params: any) {
  try {
    const slot = getActiveSlot();
    const res = await (window as any).xcoding?.project?.lspRequest?.({ slot, language, method, path: relPath, params });
    if (!res?.ok) return null;
    return res.result;
  } catch {
    return null;
  }
}

function lspCompletionKindToMonaco(kind?: number): monaco.languages.CompletionItemKind {
  // LSP CompletionItemKind is 1-based; Monaco is also 1-based but has different enum surface.
  switch (Number(kind ?? 0)) {
    case 2:
      return monaco.languages.CompletionItemKind.Method;
    case 3:
      return monaco.languages.CompletionItemKind.Function;
    case 4:
      return monaco.languages.CompletionItemKind.Constructor;
    case 5:
      return monaco.languages.CompletionItemKind.Field;
    case 6:
      return monaco.languages.CompletionItemKind.Variable;
    case 7:
      return monaco.languages.CompletionItemKind.Class;
    case 8:
      return monaco.languages.CompletionItemKind.Interface;
    case 9:
      return monaco.languages.CompletionItemKind.Module;
    case 10:
      return monaco.languages.CompletionItemKind.Property;
    case 11:
      return monaco.languages.CompletionItemKind.Unit;
    case 12:
      return monaco.languages.CompletionItemKind.Value;
    case 13:
      return monaco.languages.CompletionItemKind.Enum;
    case 14:
      return monaco.languages.CompletionItemKind.Keyword;
    case 15:
      return monaco.languages.CompletionItemKind.Snippet;
    case 16:
      return monaco.languages.CompletionItemKind.Color;
    case 17:
      return monaco.languages.CompletionItemKind.File;
    case 18:
      return monaco.languages.CompletionItemKind.Reference;
    case 19:
      return monaco.languages.CompletionItemKind.Folder;
    case 20:
      return monaco.languages.CompletionItemKind.EnumMember;
    case 21:
      return monaco.languages.CompletionItemKind.Constant;
    case 22:
      return monaco.languages.CompletionItemKind.Struct;
    case 23:
      return monaco.languages.CompletionItemKind.Event;
    case 24:
      return monaco.languages.CompletionItemKind.Operator;
    case 25:
      return monaco.languages.CompletionItemKind.TypeParameter;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

function lspMarkupToString(contents: any): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(lspMarkupToString).filter(Boolean).join("\n\n");
  if (typeof contents === "object") {
    if (typeof contents.value === "string") return contents.value;
    if (typeof contents.language === "string" && typeof contents.value === "string") return "```" + contents.language + "\n" + contents.value + "\n```";
  }
  return "";
}

function registerLspLanguageProviders(language: "python" | "go") {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: [".", ":", "_"],
    async provideCompletionItems(model, position) {
      const relPath = uriToRelPath(model.uri);
      if (!relPath) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const result = await lspRequest(language, relPath, "textDocument/completion", { position: toLspPosition(position) });
      const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
      const suggestions: monaco.languages.CompletionItem[] = items.map((it: any) => {
        const label = typeof it.label === "string" ? it.label : String(it.label ?? "");
        const insertText = it.insertText ?? label;
        const range = it.textEdit?.range ? toMonacoRange(it.textEdit.range) : null;
        const base: monaco.languages.CompletionItem = {
          label,
          kind: lspCompletionKindToMonaco(it.kind),
          detail: typeof it.detail === "string" ? it.detail : undefined,
          documentation: it.documentation ? { value: lspMarkupToString(it.documentation) } : undefined,
          insertText: typeof insertText === "string" ? insertText : label,
          insertTextRules:
            typeof insertText === "string" && typeof it.insertTextFormat === "number" && it.insertTextFormat === 2
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
          range: range ?? defaultRange
        };
        return base;
      });
      return { suggestions };
    }
  });

  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const relPath = uriToRelPath(model.uri);
      if (!relPath) return null;
      const res = await lspRequest(language, relPath, "textDocument/hover", { position: toLspPosition(position) });
      if (!res) return null;
      const contents = lspMarkupToString(res.contents);
      if (!contents) return null;
      return { contents: [{ value: contents }], range: toMonacoRange(res.range) };
    }
  });

  monaco.languages.registerDefinitionProvider(language, {
    async provideDefinition(model, position) {
      const relPath = uriToRelPath(model.uri);
      if (!relPath) return null;
      const res = await lspRequest(language, relPath, "textDocument/definition", { position: toLspPosition(position) });
      const defs = Array.isArray(res) ? res : res ? [res] : [];
      const links: monaco.languages.LocationLink[] = [];

      for (const d of defs) {
        const targetUri = fileUriToRelPath(String(d?.targetUri ?? d?.uri ?? ""));
        const range = toMonacoRange(d?.targetSelectionRange ?? d?.range ?? d?.targetRange);
        if (!targetUri) continue;
        links.push({
          originSelectionRange: undefined,
          range: range ?? new monaco.Range(1, 1, 1, 1),
          uri: monaco.Uri.from({ scheme: MONACO_URI_SCHEME, path: `/${targetUri}` })
        });
      }
      return links;
    }
  });

  monaco.languages.registerDocumentSymbolProvider(language, {
    async provideDocumentSymbols(model) {
      const relPath = uriToRelPath(model.uri);
      if (!relPath) return [];
      const res = await lspRequest(language, relPath, "textDocument/documentSymbol", {});
      const symbols = Array.isArray(res) ? res : [];

      return symbols
        .map((s: any) => ({
          name: String(s.name ?? ""),
          detail: s.detail ? String(s.detail) : "",
          kind: Number(s.kind ?? 1) as any,
          tags: [],
          range: toMonacoRange(s.range) ?? new monaco.Range(1, 1, 1, 1),
          selectionRange: toMonacoRange(s.selectionRange) ?? new monaco.Range(1, 1, 1, 1),
          children: []
        }))
        .filter((s: any) => s.name);
    }
  });
}

registerLspLanguageProviders("python");
registerLspLanguageProviders("go");
