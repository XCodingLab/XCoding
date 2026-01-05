import { EyeOff, SplitSquareVertical } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n";

type Props = {
  slot: number;
  path: string;
  projectRootPath?: string;
  onOpenUrl: (url: string) => void;
  onOpenFile?: (relPath: string) => void;
  onShowEditor?: () => void;
  onPreviewOnly?: () => void;
};

function normalizeSlashes(p: string) {
  return p.replace(/[\\\\]+/g, "/");
}

function normalizeRootPath(p?: string) {
  if (!p) return "";
  return normalizeSlashes(p).replace(/\/+$/, "");
}

function dirname(relPath: string) {
  const cleaned = relPath.replace(/^\/+/, "").replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx === -1 ? "" : cleaned.slice(0, idx);
}

function resolvePath(baseAbs: string, ref: string): string {
  const base = normalizeSlashes(baseAbs);
  const raw = normalizeSlashes(ref);
  const combined = raw.startsWith("/") ? raw : `${base}/${raw}`;
  const parts = combined.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return combined.startsWith("/") ? `/${stack.join("/")}` : stack.join("/");
}

function resolveImageSrc(src: string | undefined, baseAbs: string): string | undefined {
  if (!src) return src;
  const s = src.trim();
  if (!s) return s;
  if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:")) return s;
  if (s.startsWith("local-file://")) return s;
  if (s.startsWith("file://")) return `local-file://${s.slice("file://".length)}`;
  if (s.startsWith("/")) return `local-file://${s}`;
  const abs = resolvePath(baseAbs, s);
  return `local-file://${abs}`;
}

export default function MarkdownPreviewView({ slot, path, projectRootPath, onOpenUrl, onOpenFile, onShowEditor, onPreviewOnly }: Props) {
  const { t } = useI18n();
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const baseAbs = useMemo(() => {
    const root = normalizeRootPath(projectRootPath);
    const dir = dirname(path);
    return dir ? `${root}/${dir}` : root;
  }, [path, projectRootPath]);

  useEffect(() => {
    setIsLoading(true);
    window.xcoding.project
      .readFile({ slot, path })
      .then((res) => {
        if (!res.ok) {
          setError(res.reason ?? "read_failed");
          setContent("");
          return;
        }
        setError(null);
        setContent(res.content ?? "");
      })
      .finally(() => setIsLoading(false));
  }, [path, slot]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slot?: number; path?: string; content?: string } | undefined;
      if (!detail) return;
      if (detail.slot !== slot) return;
      if (detail.path !== path) return;
      if (typeof detail.content !== "string") return;
      setContent(detail.content);
    };
    window.addEventListener("xcoding:fileContentChanged", handler as any);
    return () => window.removeEventListener("xcoding:fileContentChanged", handler as any);
  }, [path, slot]);

  const components = useMemo(() => {
    return {
      pre: ({ children }: any) => (
        <pre className="my-3 overflow-auto rounded border border-[var(--vscode-panel-border)] bg-[rgba(0,0,0,0.2)] p-3 text-[12px]">
          {children}
        </pre>
      ),
      code: ({ className, children }: any) => {
        const text = String(children ?? "");
        const isBlock = text.includes("\n");
        if (isBlock) {
          return (
            <code className={["block whitespace-pre", className || ""].join(" ")}>
              {text.replace(/\n$/, "")}
            </code>
          );
        }
        return <code className="rounded bg-[rgba(255,255,255,0.08)] px-1 py-0.5 text-[12px]">{children}</code>;
      },
      p: ({ children, ...props }: any) => (
        <p className="my-3 leading-6 text-[13px] text-[var(--vscode-foreground)]" {...props}>
          {children}
        </p>
      ),
      ul: ({ children, ...props }: any) => (
        <ul className="my-3 ml-5 list-disc text-[13px] text-[var(--vscode-foreground)]" {...props}>
          {children}
        </ul>
      ),
      ol: ({ children, ...props }: any) => (
        <ol className="my-3 ml-5 list-decimal text-[13px] text-[var(--vscode-foreground)]" {...props}>
          {children}
        </ol>
      ),
      li: ({ children, ...props }: any) => (
        <li className="my-1" {...props}>
          {children}
        </li>
      ),
      a: ({ children, href, ...props }: any) => {
        const url = String(href ?? "");
        const isHttp = url.startsWith("http://") || url.startsWith("https://");
        const isAnchor = url.startsWith("#");
        return (
          <a
            className="text-[var(--vscode-focusBorder)] underline underline-offset-2 hover:opacity-90"
            href={href}
            {...props}
            onClick={(e) => {
              if (isAnchor) return;
              e.preventDefault();
              e.stopPropagation();
              if (isHttp) {
                onOpenUrl(url);
                return;
              }
              if (onOpenFile && url) {
                const rel = url.replace(/^\.\/+/, "");
                if (rel && !rel.startsWith("..")) onOpenFile(rel);
                return;
              }
            }}
          >
            {children}
          </a>
        );
      },
      h1: ({ children, ...props }: any) => (
        <h1 className="mb-3 mt-6 text-xl font-semibold text-[var(--vscode-foreground)]" {...props}>
          {children}
        </h1>
      ),
      h2: ({ children, ...props }: any) => (
        <h2 className="mb-2 mt-5 text-lg font-semibold text-[var(--vscode-foreground)]" {...props}>
          {children}
        </h2>
      ),
      h3: ({ children, ...props }: any) => (
        <h3 className="mb-2 mt-4 text-base font-semibold text-[var(--vscode-foreground)]" {...props}>
          {children}
        </h3>
      ),
      blockquote: ({ children, ...props }: any) => (
        <blockquote className="my-4 border-l-2 border-[var(--vscode-panel-border)] pl-3 text-[13px] text-[var(--vscode-descriptionForeground)]" {...props}>
          {children}
        </blockquote>
      ),
      hr: (props: any) => <hr className="my-5 border-[var(--vscode-panel-border)]" {...props} />,
      table: ({ children, ...props }: any) => (
        <div className="my-4 overflow-x-auto">
          <table className="w-full border-collapse border border-[var(--vscode-panel-border)] text-[12px]" {...props}>
            {children}
          </table>
        </div>
      ),
      th: ({ children, ...props }: any) => (
        <th className="border border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBarSectionHeader-background)] px-2 py-1 text-left font-semibold" {...props}>
          {children}
        </th>
      ),
      td: ({ children, ...props }: any) => (
        <td className="border border-[var(--vscode-panel-border)] px-2 py-1" {...props}>
          {children}
        </td>
      ),
      img: ({ src, alt, ...props }: any) => (
        <img className="my-3 max-w-full rounded border border-[var(--vscode-panel-border)]" src={resolveImageSrc(src, baseAbs)} alt={alt} loading="lazy" {...props} />
      )
    };
  }, [baseAbs, onOpenFile, onOpenUrl]);

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">{t("loadingPreview")}</div>;
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-400">
        {t("previewError")} {error}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex h-9 items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-tab-inactiveBackground)] px-2">
        <div className="min-w-0 truncate text-[11px] text-[var(--vscode-foreground)]">
          {t("previewTitle")} · {path}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onShowEditor ? (
            <button
              className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              type="button"
              title={t("showEditorSideBySide")}
              onClick={onShowEditor}
            >
              <SplitSquareVertical className="h-4 w-4" />
            </button>
          ) : null}
          {onPreviewOnly ? (
            <button
              className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              type="button"
              title={t("previewOnly")}
              onClick={onPreviewOnly}
            >
              <EyeOff className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeRaw]} components={components as any}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
