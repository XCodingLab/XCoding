import { useEffect, useMemo, useRef, useState } from "react";
import { ensureMonacoLanguage, monaco } from "../../monacoSetup";
import { classifyDiffLine } from "../../diffSupport";
import { isMustLanguage, type MonacoLanguageId } from "../../languageSupport";

const MAX_CODE_BLOCK_CHARS = 50_000;
const MAX_CODE_BLOCK_LINES = 400;
const MAX_CACHE_ENTRIES = 200;

const htmlCache = new Map<string, string>();

function escapeHtml(text: string) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDiffHtml(code: string) {
  const lines = String(code ?? "").replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line) => {
      const kind = classifyDiffLine(line);
      const safe = escapeHtml(line);
      if (!kind) return safe;
      return `<span class="xcoding-diff-code-line xcoding-diff-code-line-${kind}">${safe}</span>`;
    })
    .join("\n");
}

function countLinesUpToLimit(text: string, limit: number) {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > limit) return lines;
    }
  }
  return lines;
}

function hash32(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function cacheGet(key: string) {
  const v = htmlCache.get(key);
  if (v === undefined) return null;
  htmlCache.delete(key);
  htmlCache.set(key, v);
  return v;
}

function cacheSet(key: string, value: string) {
  htmlCache.set(key, value);
  while (htmlCache.size > MAX_CACHE_ENTRIES) {
    const first = htmlCache.keys().next().value as string | undefined;
    if (!first) break;
    htmlCache.delete(first);
  }
}

type Props = {
  code: string;
  languageId: MonacoLanguageId;
  className?: string;
};

export default function MonacoCodeBlock({ code, languageId, className }: Props) {
  const normalizedCode = useMemo(() => String(code ?? "").replace(/\n$/, ""), [code]);
  const isCandidate =
    isMustLanguage(languageId) &&
    normalizedCode.length > 0 &&
    normalizedCode.length <= MAX_CODE_BLOCK_CHARS &&
    countLinesUpToLimit(normalizedCode, MAX_CODE_BLOCK_LINES) <= MAX_CODE_BLOCK_LINES;

  const cacheKey = useMemo(() => {
    if (!isCandidate) return "";
    return `${languageId}:${normalizedCode.length}:${hash32(normalizedCode)}`;
  }, [isCandidate, languageId, normalizedCode]);

  const [html, setHtml] = useState<string | null>(() => (cacheKey ? cacheGet(cacheKey) : null));
  const seqRef = useRef(0);

  useEffect(() => {
    if (!cacheKey) {
      setHtml(null);
      return;
    }
    const cached = cacheGet(cacheKey);
    if (cached) {
      setHtml(cached);
      return;
    }

    setHtml(null);
    const seq = (seqRef.current += 1);
    let cancelled = false;

    void (async () => {
      try {
        const next =
          languageId === "diff"
            ? renderDiffHtml(normalizedCode)
            : (await (async () => {
                await ensureMonacoLanguage(languageId);
                return await monaco.editor.colorize(normalizedCode, languageId, { tabSize: 2 });
              })());
        if (cancelled) return;
        if (seqRef.current !== seq) return;
        const out = String(next ?? "");
        if (!out.trim()) return;
        cacheSet(cacheKey, out);
        setHtml(out);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, languageId, normalizedCode]);

  const cls = ["block whitespace-pre font-mono", className || ""].join(" ").trim();

  if (!cacheKey || !html) return <code className={cls}>{normalizedCode}</code>;

  return <code className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}
