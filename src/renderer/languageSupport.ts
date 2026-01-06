export type MonacoLanguageId =
  | "typescript"
  | "javascript"
  | "json"
  | "html"
  | "css"
  | "markdown"
  | "yaml"
  | "shell"
  | "diff"
  | "python"
  | "go"
  | "java"
  | "plaintext";

export const MUST_LANGUAGES: ReadonlySet<Exclude<MonacoLanguageId, "plaintext">> = new Set([
  "typescript",
  "javascript",
  "json",
  "html",
  "css",
  "markdown",
  "yaml",
  "shell",
  "diff",
  "python",
  "go",
  "java"
]);

export const MUST_LSP_LANGUAGES: ReadonlySet<Exclude<MonacoLanguageId, "plaintext">> = new Set(["python"]);

function extLower(path: string) {
  const cleaned = String(path ?? "").trim();
  const base = cleaned.split(/[?#]/, 1)[0] ?? cleaned;
  const idx = base.lastIndexOf(".");
  if (idx === -1) return "";
  return base.slice(idx).toLowerCase();
}

export function languageFromPath(path: string): MonacoLanguageId {
  const lower = String(path ?? "").toLowerCase();
  const ext = extLower(lower);

  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".css") return "css";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh") return "shell";
  if (ext === ".diff" || ext === ".patch") return "diff";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  return "plaintext";
}

export function languageFromFence(raw: string | undefined | null): MonacoLanguageId {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^language-/, "")
    .replace(/^lang-/, "");
  if (!key) return "plaintext";

  if (key === "ts" || key === "tsx" || key === "typescript") return "typescript";
  if (key === "js" || key === "jsx" || key === "javascript") return "javascript";
  if (key === "json") return "json";
  if (key === "html") return "html";
  if (key === "css") return "css";
  if (key === "md" || key === "markdown") return "markdown";
  if (key === "yml" || key === "yaml") return "yaml";
  if (key === "sh" || key === "bash" || key === "zsh" || key === "shell") return "shell";
  if (key === "diff" || key === "patch") return "diff";
  if (key === "py" || key === "python") return "python";
  if (key === "go" || key === "golang") return "go";
  if (key === "java") return "java";

  return "plaintext";
}

export function parseFenceClassName(className: string | undefined | null): MonacoLanguageId {
  const cls = String(className ?? "");
  const m = cls.match(/(?:^|\\s)language-([^\\s]+)/i);
  if (!m) return "plaintext";
  return languageFromFence(m[1] ?? "");
}

export function isMustLanguage(languageId: MonacoLanguageId) {
  return languageId !== "plaintext" && MUST_LANGUAGES.has(languageId);
}

export function shouldEnableLsp(languageId: MonacoLanguageId) {
  return languageId !== "plaintext" && MUST_LSP_LANGUAGES.has(languageId);
}
