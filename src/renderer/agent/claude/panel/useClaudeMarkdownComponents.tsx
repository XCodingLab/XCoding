import { useMemo } from "react";
import type { Components } from "react-markdown";

import { isMustLanguage, parseFenceClassName } from "../../../languageSupport";
import MonacoCodeBlock from "../../shared/MonacoCodeBlock";
import { parseRelFileHref } from "./panelUtils";

type Params = {
  slot: number;
  onOpenUrl: (url: string) => void;
  onOpenFile: (relPath: string, line?: number, column?: number) => void;
  pushSystemMessage: (text: string) => void;
};

export function useClaudeMarkdownComponents({ slot, onOpenUrl, onOpenFile, pushSystemMessage }: Params): Components {
  return useMemo(() => {
    return {
      p: ({ children }: any) => <p className="my-3 whitespace-pre-wrap text-[13px] leading-[1.095rem] text-[var(--vscode-foreground)]">{children}</p>,
      a: ({ children, href }: any) => {
        const url = String(href ?? "");
        const isHttp = url.startsWith("http://") || url.startsWith("https://");
        const isAnchor = url.startsWith("#");
        return (
          <a
            className="text-[color-mix(in_srgb,var(--vscode-focusBorder)_90%,white)] underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
            href={href}
            target={isHttp ? "_blank" : undefined}
            rel={isHttp ? "noreferrer" : undefined}
            onClick={(e) => {
              if (isAnchor) return;
              e.preventDefault();
              e.stopPropagation();
              if (isHttp) {
                onOpenUrl(url);
                return;
              }
              const parsed = parseRelFileHref(url);
              if (!parsed) return;
              void (async () => {
                try {
                  const res = await window.xcoding.project.stat({ slot, path: parsed.relPath });
                  if (!res?.ok) {
                    pushSystemMessage(`Failed to open path: ${String(res?.reason ?? "stat_failed")}`);
                    return;
                  }
                  if (res.exists === false) {
                    pushSystemMessage(`Path not found: ${parsed.relPath}`);
                    return;
                  }
                  if (res.isDirectory) {
                    window.dispatchEvent(new CustomEvent("xcoding:revealInExplorer", { detail: { slot, relPath: parsed.relPath, kind: "dir" } }));
                    return;
                  }
                  onOpenFile(parsed.relPath, parsed.line, parsed.column);
                } catch (err) {
                  pushSystemMessage(`Failed to open path: ${err instanceof Error ? err.message : String(err)}`);
                }
              })();
            }}
          >
            {children}
          </a>
        );
      },
      ul: ({ children }: any) => <ul className="my-3 list-disc pl-6 text-[13px] leading-[1.095rem] text-[var(--vscode-foreground)]">{children}</ul>,
      ol: ({ children }: any) => <ol className="my-3 list-decimal pl-6 text-[13px] leading-[1.095rem] text-[var(--vscode-foreground)]">{children}</ol>,
      li: ({ children }: any) => <li className="my-1">{children}</li>,
      blockquote: ({ children }: any) => (
        <blockquote className="my-3 border-l-2 border-[color-mix(in_srgb,var(--vscode-panel-border)_90%,white)] pl-3 text-[13px] leading-[1.095rem] text-[var(--vscode-foreground)] opacity-90">
          {children}
        </blockquote>
      ),
      h1: ({ children }: any) => <h1 className="my-4 text-[18px] font-semibold text-[var(--vscode-foreground)]">{children}</h1>,
      h2: ({ children }: any) => <h2 className="my-4 text-[16px] font-semibold text-[var(--vscode-foreground)]">{children}</h2>,
      h3: ({ children }: any) => <h3 className="my-3 text-[14px] font-semibold text-[var(--vscode-foreground)]">{children}</h3>,
      pre: ({ children }: any) => <pre className="my-3 overflow-auto rounded border border-token-border bg-black/20 p-3 text-[12px]">{children}</pre>,
      code: ({ inline, className, children }: any) => {
        const text = String(children ?? "").replace(/\n$/, "");
        const isInline = Boolean(inline) || (!className && !text.includes("\n"));
        if (isInline) return <code className="xcoding-inline-code font-mono text-[12px]">{text}</code>;
        const languageId = parseFenceClassName(className);
        if (!isMustLanguage(languageId)) return <code className="block whitespace-pre font-mono">{text}</code>;
        return <MonacoCodeBlock code={text} languageId={languageId} className={className} />;
      },
      hr: () => <hr className="my-4 border-t border-[var(--vscode-panel-border)]" />,
      table: ({ children }: any) => (
        <div className="my-3 overflow-auto rounded border border-[var(--vscode-panel-border)]">
          <table className="w-full border-collapse">{children}</table>
        </div>
      ),
      thead: ({ children }: any) => <thead className="bg-black/10">{children}</thead>,
      th: ({ children }: any) => <th className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-left text-[12px]">{children}</th>,
      td: ({ children }: any) => <td className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-[12px]">{children}</td>,
      tr: ({ children }: any) => <tr className="align-top">{children}</tr>,
      tbody: ({ children }: any) => <tbody>{children}</tbody>
    };
  }, [onOpenFile, onOpenUrl, pushSystemMessage, slot]);
}

