import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { extractPromptRequest } from "./codexPrompt";
import { useI18n } from "./i18n";

type ApprovalRequest = {
  rpcId: number;
  method: string;
  params: any;
};

type PlanStep = { step: string; status: "pending" | "inProgress" | "completed" | string };

type TurnView = {
  id: string;
  status?: string;
  items: any[];
  error?: any;
  plan?: { explanation?: string | null; steps: PlanStep[] };
  diff?: string | null;
  snapshot?: { status: "available" | "applied" } | null;
};

type ThreadView = {
  id: string;
  preview?: string;
  turns: TurnView[];
  latestDiff?: string | null;
};

type Props = {
  thread: ThreadView | null;
  approvalsByItemId: Record<string, ApprovalRequest | undefined>;
  onApprovalDecision: (itemId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") => void;
  onTurnApply?: (turnId: string) => void;
  onTurnRevert?: (turnId: string) => void;
  bottomInsetPx?: number;
  onOpenUrl?: (url: string) => void;
  onOpenImage?: (absPathOrUrl: string) => void;
};

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderUserContent(content: any[] | undefined) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image" && typeof b.url === "string") return `[image] ${b.url}`;
      if (b.type === "localImage" && typeof b.path === "string") return `[localImage] ${b.path}`;
      return formatJson(b);
    })
    .filter(Boolean)
    .join("\n");
  return extractPromptRequest(text);
}

function renderAgentModeLabel(mode: string) {
  if (mode === "read-only") return "Chat";
  if (mode === "auto") return "Agent";
  if (mode === "full-access") return "Agent (full access)";
  return mode || "unknown";
}

function getTurnStatusLabel(status: string | undefined) {
  const s = String(status ?? "").toLowerCase();
  if (!s) return { text: "unknown", kind: "unknown" as const };
  if (s.includes("progress") || s === "inprogress" || s === "in_progress") return { text: "in progress", kind: "running" as const };
  if (s.includes("complete") || s === "completed") return { text: "completed", kind: "done" as const };
  if (s.includes("error") || s.includes("failed")) return { text: status ?? "error", kind: "error" as const };
  return { text: status ?? "unknown", kind: "unknown" as const };
}

function readItemStatus(item: any) {
  const status = String(item?.status ?? "").toLowerCase();
  if (!status) return { kind: "unknown" as const, raw: "" };
  if (status.includes("progress") || status === "inprogress" || status === "in_progress") return { kind: "running" as const, raw: status };
  if (status.includes("complete") || status === "completed" || status === "done") return { kind: "done" as const, raw: status };
  if (status.includes("error") || status.includes("failed")) return { kind: "error" as const, raw: status };
  return { kind: "unknown" as const, raw: status };
}

function isPureTextItem(type: string) {
  return type === "agentMessage";
}

function readCommandExecutionOutput(item: any): string {
  const aggregated = typeof item?.aggregatedOutput === "string" ? item.aggregatedOutput : "";
  if (aggregated) return aggregated;

  const output = item?.output;
  if (typeof output === "string" && output) return output;
  if (Array.isArray(output) && output.length) return output.map((v) => String(v ?? "")).join("");

  const stdout = typeof item?.stdout === "string" ? item.stdout : "";
  const stderr = typeof item?.stderr === "string" ? item.stderr : "";
  if (stdout || stderr) return [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");

  const result = item?.result;
  if (result && typeof result === "object") {
    const rAgg = typeof (result as any)?.aggregatedOutput === "string" ? (result as any).aggregatedOutput : "";
    if (rAgg) return rAgg;
    const rOut = (result as any)?.output;
    if (typeof rOut === "string" && rOut) return rOut;
    const rStdout = typeof (result as any)?.stdout === "string" ? (result as any).stdout : "";
    const rStderr = typeof (result as any)?.stderr === "string" ? (result as any).stderr : "";
    if (rStdout || rStderr) return [rStdout, rStderr].filter(Boolean).join(rStdout && rStderr ? "\n" : "");
  }

  return "";
}

function readReasoningText(item: any): string {
  if (Array.isArray(item?.summary) && item.summary.join("")) return item.summary.join("");
  if (Array.isArray(item?.content) && item.content.join("")) return item.content.join("");
  const text = typeof item?.text === "string" ? item.text : "";
  if (text) return text;
  const summaryText = typeof item?.summaryText === "string" ? item.summaryText : "";
  if (summaryText) return summaryText;
  return "";
}

function TerminalBlock({ title, text }: { title?: string; text: string }) {
  const output = String(text ?? "");
  return (
    <div
      className="overflow-auto rounded border border-[var(--vscode-panel-border)] font-mono"
      style={{ background: "var(--vscode-terminal-background)", color: "var(--vscode-terminal-foreground)" }}
    >
      {title ? (
        <div className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-[10px] text-[var(--vscode-descriptionForeground)]">{title}</div>
      ) : null}
      <pre className="whitespace-pre-wrap px-2 py-1 text-[11px] leading-4">{output}</pre>
    </div>
  );
}

function DiffLineBlock({ diff }: { diff: string }) {
  const lines = String(diff ?? "").replace(/\r\n/g, "\n").split("\n");
  return (
    <div className="overflow-auto rounded border border-[var(--vscode-panel-border)] bg-black/10 font-mono">
      {lines.map((line, idx) => {
        const isMeta =
          line.startsWith("*** ") ||
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("new file mode ") ||
          line.startsWith("deleted file mode ") ||
          line.startsWith("rename from ") ||
          line.startsWith("rename to ") ||
          line.startsWith("similarity index ") ||
          line.startsWith("dissimilarity index ");
        const isHunk = line.startsWith("@@");
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isRemove = line.startsWith("-") && !line.startsWith("---");

        const cls = (() => {
          if (isMeta) return "text-[10px] text-[var(--vscode-descriptionForeground)]";
          if (isHunk) return "text-[10px] text-[color-mix(in_srgb,var(--vscode-focusBorder)_85%,white)]";
          if (isAdd) return "text-[11px] text-[color-mix(in_srgb,#89d185_90%,white)] bg-[color-mix(in_srgb,#89d185_12%,transparent)]";
          if (isRemove) return "text-[11px] text-[color-mix(in_srgb,#f14c4c_90%,white)] bg-[color-mix(in_srgb,#f14c4c_12%,transparent)]";
          return "text-[11px] text-[var(--vscode-foreground)]";
        })();

        return (
          <div key={idx} className={["whitespace-pre px-2 py-0.5", cls].join(" ")}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function shouldShowThinkingPlaceholder(turn: TurnView) {
  if (getTurnStatusLabel(turn.status).kind !== "running") return false;
  const items = Array.isArray(turn.items) ? turn.items : [];
  if (!items.length) return true;
  const last = items[items.length - 1];
  const lastType = String((last as any)?.type ?? "");
  if (lastType === "agentMessage") return false;
  if (lastType === "userMessage") return true;
  return readItemStatus(last).kind !== "running";
}

function computeFileChangeSummary(turn: TurnView) {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const fileChanges = items.filter((it: any) => String(it?.type ?? "") === "fileChange");
  if (!fileChanges.length) return null;

  const byPath = new Map<string, { path: string; added: number; removed: number }>();

  const addCountsFromDiff = (diffText: string) => {
    let added = 0;
    let removed = 0;
    for (const line of String(diffText ?? "").split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("*** ")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    return { added, removed };
  };

  let combinedDiff = "";
  for (const fc of fileChanges) {
    const changes = Array.isArray((fc as any)?.changes) ? (fc as any).changes : [];
    for (const c of changes) {
      const p = String(c?.path ?? "").trim();
      if (!p) continue;
      const diff = String(c?.diff ?? "");
      const { added, removed } = addCountsFromDiff(diff);
      const prev = byPath.get(p) ?? { path: p, added: 0, removed: 0 };
      prev.added += added;
      prev.removed += removed;
      byPath.set(p, prev);
      if (diff.trim()) combinedDiff += (combinedDiff ? "\n" : "") + diff.trim() + "\n";
    }
  }

  const files = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return null;
  const fallbackDiff = typeof (turn as any)?.diff === "string" ? String((turn as any).diff) : "";
  const diff = fallbackDiff.trim() ? fallbackDiff : combinedDiff.trim();
  return { files, diff };
}

function titleForItem(item: any) {
  const type = String(item?.type ?? "unknown");
  if (type === "turnThinking") return "Thinking";
  if (type === "reasoning") return "Thinking";
  if (type === "localToolCall") {
    const name = String(item?.name ?? "").trim();
    return name ? `Tool · ${name}` : "Tool";
  }
  if (type === "mcpToolCall") {
    const server = String(item?.server ?? "");
    const tool = String(item?.tool ?? "");
    const name = [server, tool].filter(Boolean).join(" · ");
    return name ? `MCP · ${name}` : "MCP";
  }
  if (type === "commandExecution") {
    const cmd = String(item?.command ?? "");
    return cmd ? `Command · ${cmd}` : "Command";
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    const countsForDiff = (diffText: string) => {
      let added = 0;
      let removed = 0;
      for (const line of String(diffText ?? "").split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
        if (line.startsWith("*** ")) continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
      return { added, removed };
    };
    const entries = changes
      .map((c: any) => {
        const p = String(c?.path ?? "").trim();
        const diff = String(c?.diff ?? "");
        const { added, removed } = countsForDiff(diff);
        return { path: p || "file", added, removed };
      })
      .filter((e: { path: string; added: number; removed: number }) => e.path);
    const first = entries[0] ?? null;
    if (!first) return "Edited";
    const name = first.path.split("/").pop() ?? first.path;
    const parts: string[] = [];
    if (first.added) parts.push(`+${first.added}`);
    if (first.removed) parts.push(`-${first.removed}`);
    return parts.length ? `Edited · ${name} (${parts.join(" ")})` : `Edited · ${name}`;
  }
  if (type === "webSearch") return "Web search";
  if (type === "imageView") return "Image";
  if (type === "agentModeChange") return `Mode · ${String(item?.mode ?? "unknown")}`;
  if (type === "turnDiff") return "Diff";
  if (type === "turnError") return "Error";
  return `Item · ${type}`;
}

const localImageDataUrlCache = new Map<string, string>();

function toLocalFileUrl(path: string) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized.startsWith("local-file://")) return normalized;
  if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("data:")) return normalized;
  if (normalized.startsWith("file://")) return `local-file://${normalized.slice("file://".length)}`;
  // Ensure absolute-looking path for the protocol handler (Windows drive letter becomes /C:/...).
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `local-file://${prefixed}`;
}

function LocalImagePreview({
  path,
  alt,
  onOpenUrl,
  onOpenImage
}: {
  path: string;
  alt?: string;
  onOpenUrl?: (url: string) => void;
  onOpenImage?: (absPathOrUrl: string) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState(() => localImageDataUrlCache.get(path) ?? "");

  useEffect(() => {
    if (!path) {
      setUrl("");
      return;
    }
    const cached = localImageDataUrlCache.get(path);
    if (cached) {
      setUrl(cached);
      return;
    }

    let canceled = false;
    void (async () => {
      const res = await window.xcoding.codex.readLocalImageAsDataUrl({ path });
      if (canceled) return;
      if (!res.ok || !res.result?.dataUrl) return;
      localImageDataUrlCache.set(path, res.result.dataUrl);
      setUrl(res.result.dataUrl);
    })();

    return () => {
      canceled = true;
    };
  }, [path]);

  if (!url) return null;
  const openUrl = onOpenUrl ?? ((href: string) => window.open(href, "_blank", "noopener,noreferrer"));
  return (
    <button
      type="button"
      onClick={() => {
        const href = toLocalFileUrl(path);
        if (!href) return;
        if (onOpenImage) onOpenImage(href);
        else openUrl(href);
      }}
      className="block overflow-hidden rounded-lg border border-[var(--vscode-panel-border)] bg-black/10 text-left"
      title={t("openImage")}
    >
      <img src={url} className="h-24 w-24 object-cover" alt={alt || path || t("imageAlt")} />
    </button>
  );
}

function UserBlocks({
  content,
  onOpenUrl,
  onOpenImage
}: {
  content: any[] | undefined;
  onOpenUrl?: (url: string) => void;
  onOpenImage?: (absPathOrUrl: string) => void;
}) {
  const { t } = useI18n();
  const blocks = Array.isArray(content) ? content : [];
  const images = blocks
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      if (b.type === "image" && typeof b.url === "string" && b.url) return { kind: "url" as const, url: b.url };
      if (b.type === "localImage" && typeof b.path === "string" && b.path) return { kind: "local" as const, path: b.path };
      return null;
    })
    .filter(Boolean) as Array<{ kind: "url"; url: string } | { kind: "local"; path: string }>;

  const text = extractPromptRequest(
    blocks
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
  );

  if (!images.length && !text.trim()) return null;

  const openUrl = onOpenUrl ?? ((href: string) => window.open(href, "_blank", "noopener,noreferrer"));
  return (
    <div className="grid gap-2">
      {images.length ? (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((img, idx) =>
            img.kind === "url" ? (
              <button
                key={`${img.url}:${idx}`}
                type="button"
                onClick={() => {
                  if (onOpenImage) onOpenImage(img.url);
                  else openUrl(img.url);
                }}
                className="block overflow-hidden rounded-lg border border-[var(--vscode-panel-border)] bg-black/10 text-left"
                title={t("openImage")}
              >
                <img src={img.url} className="h-24 w-24 object-cover" alt={t("imageAlt")} />
              </button>
            ) : (
              <LocalImagePreview key={`${img.path}:${idx}`} path={img.path} alt={img.path} onOpenUrl={openUrl} onOpenImage={onOpenImage} />
            )
          )}
        </div>
      ) : null}
      {text.trim() ? <div className="whitespace-pre-wrap">{text}</div> : null}
    </div>
  );
}

export default function CodexThreadView({
  thread,
  approvalsByItemId,
  onApprovalDecision,
  onTurnApply,
  onTurnRevert,
  bottomInsetPx,
  onOpenUrl,
  onOpenImage
}: Props) {
  const { t } = useI18n();
  const turns = thread?.turns ?? [];
  const maxTurnsToRender = 40;
  const maxTurns = turns.length;
  const [visibleTurnsCount, setVisibleTurnsCount] = useState<number>(maxTurnsToRender);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const lastAutoOpenIdRef = useRef<string>("");
  const [openByUser, setOpenByUser] = useState<Record<string, boolean>>({});

  const safeVisibleTurnsCount = Math.min(Math.max(visibleTurnsCount, maxTurnsToRender), maxTurns);
  const visibleTurns = maxTurns > safeVisibleTurnsCount ? turns.slice(maxTurns - safeVisibleTurnsCount) : turns;

  const markdownComponents = useMemo(() => {
    return {
      p: ({ children }: any) => <p className="my-3 whitespace-pre-wrap text-[13px] leading-6 text-[var(--vscode-foreground)]">{children}</p>,
      a: ({ children, href }: any) => (
        <a
          className="text-[color-mix(in_srgb,var(--vscode-focusBorder)_90%,white)] underline decoration-white/20 underline-offset-2 hover:decoration-white/60"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      ),
      ul: ({ children }: any) => <ul className="my-3 list-disc pl-6 text-[13px] leading-6 text-[var(--vscode-foreground)]">{children}</ul>,
      ol: ({ children }: any) => <ol className="my-3 list-decimal pl-6 text-[13px] leading-6 text-[var(--vscode-foreground)]">{children}</ol>,
      li: ({ children }: any) => <li className="my-1">{children}</li>,
      blockquote: ({ children }: any) => (
        <blockquote className="my-3 border-l-2 border-[color-mix(in_srgb,var(--vscode-panel-border)_90%,white)] pl-3 text-[13px] leading-6 text-[var(--vscode-foreground)] opacity-90">
          {children}
        </blockquote>
      ),
      h1: ({ children }: any) => <h1 className="my-4 text-[18px] font-semibold text-[var(--vscode-foreground)]">{children}</h1>,
      h2: ({ children }: any) => <h2 className="my-4 text-[16px] font-semibold text-[var(--vscode-foreground)]">{children}</h2>,
      h3: ({ children }: any) => <h3 className="my-3 text-[14px] font-semibold text-[var(--vscode-foreground)]">{children}</h3>,
      pre: ({ children }: any) => <pre className="my-3 overflow-auto rounded border border-token-border bg-black/20 p-3 text-[12px]">{children}</pre>,
      code: ({ children }: any) => {
        const text = String(children ?? "");
        const isBlock = text.includes("\n");
        if (isBlock) return <code className="block whitespace-pre">{text.replace(/\n$/, "")}</code>;
        return <code className="rounded bg-white/10 px-1 py-0.5 text-[12px]">{children}</code>;
      },
      hr: () => <hr className="my-4 border-t border-[var(--vscode-panel-border)]" />,
      table: ({ children }: any) => (
        <div className="my-3 overflow-auto rounded border border-[var(--vscode-panel-border)]">{children}</div>
      ),
      thead: ({ children }: any) => <thead className="bg-black/10">{children}</thead>,
      th: ({ children }: any) => <th className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-left text-[12px]">{children}</th>,
      td: ({ children }: any) => <td className="border-b border-[var(--vscode-panel-border)] px-2 py-1 text-[12px]">{children}</td>,
      tr: ({ children }: any) => <tr className="align-top">{children}</tr>,
      tbody: ({ children }: any) => <tbody>{children}</tbody>
    };
  }, []);

  const bottomKey = useMemo(() => {
    const threadId = String(thread?.id ?? "");
    const turnsCount = turns.length;
    let itemsCount = 0;
    let lastLen = 0;
    for (const t of turns) itemsCount += Array.isArray(t.items) ? t.items.length : 0;
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    if (lastTurn && Array.isArray(lastTurn.items) && lastTurn.items.length) {
      const lastItem = lastTurn.items[lastTurn.items.length - 1];
      const type = String((lastItem as any)?.type ?? "");
      if (type === "agentMessage") lastLen = String((lastItem as any)?.text ?? "").length;
      else if (type === "commandExecution") lastLen = readCommandExecutionOutput(lastItem).length;
      else if (type === "reasoning") lastLen = readReasoningText(lastItem).length;
      else lastLen = formatJson(lastItem).length;
    } else if (lastTurn?.diff) lastLen = String(lastTurn.diff).length;
    else if (lastTurn?.error) lastLen = formatJson(lastTurn.error).length;
    return `${threadId}:${turnsCount}:${itemsCount}:${lastLen}`;
  }, [thread?.id, turns]);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [bottomKey]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    isNearBottomRef.current = dist <= 24;
  };

  const flattenedItems = useMemo(() => {
    const rows: Array<{ turn: TurnView; item: any; itemId: string; type: string }> = [];
    for (const turn of visibleTurns) {
      const items = Array.isArray(turn.items) ? turn.items : [];
      items.forEach((item: any, idx: number) => {
        const itemId = String(item?.id ?? `${turn.id}:${idx}`);
        rows.push({ turn, item, itemId, type: String(item?.type ?? "unknown") });
      });
      if (shouldShowThinkingPlaceholder(turn)) {
        rows.push({ turn, item: { id: `${turn.id}:thinking`, type: "turnThinking" }, itemId: `${turn.id}:thinking`, type: "turnThinking" });
      }
      const done = getTurnStatusLabel(turn.status).kind !== "running";
      if (done) {
        const summary = computeFileChangeSummary(turn);
        if (summary) rows.push({ turn, item: { id: `${turn.id}:changesSummary`, type: "turnChangesSummary", summary }, itemId: `${turn.id}:changesSummary`, type: "turnChangesSummary" });
      }
    }
    return rows;
  }, [visibleTurns, bottomKey]);

  const autoOpenItemId = useMemo(() => {
    if (!flattenedItems.length) return "";
    const last = flattenedItems[flattenedItems.length - 1];
    if (last.type === "userMessage" || last.type === "turnThinking") return "";
    if (isPureTextItem(last.type)) return "";
    return last.itemId;
  }, [flattenedItems]);

  useEffect(() => {
    if (!autoOpenItemId) return;
    if (lastAutoOpenIdRef.current === autoOpenItemId) return;
    lastAutoOpenIdRef.current = autoOpenItemId;
  }, [autoOpenItemId]);

  const baseInset = thread ? 120 : 0;
  const requestedInset = typeof bottomInsetPx === "number" ? bottomInsetPx : 0;
  const bottomInset = Math.max(baseInset, requestedInset);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-auto p-2"
      style={{ paddingBottom: `calc(${bottomInset}px + env(safe-area-inset-bottom, 0px))` }}
    >
      {!thread ? (
        <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-token-description-foreground">{t("codexSelectOrStartConversation")}</div>
      ) : null}

      {/* Intentionally no empty-state placeholder. */}

      {maxTurns > safeVisibleTurnsCount ? (
        <div className="mb-3 flex items-center justify-between rounded border border-token-border bg-token-input-background px-3 py-2 text-[12px]">
          <div className="text-token-description-foreground">
            {t("codexShowingLastTurns")} {safeVisibleTurnsCount} {t("codexOf")} {maxTurns} {t("codexTurns")}
          </div>
          <button
            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
            type="button"
            onClick={() => setVisibleTurnsCount((c: number) => Math.min(maxTurns, c + maxTurnsToRender))}
          >
            Load more
          </button>
        </div>
      ) : null}

      {flattenedItems.map(({ turn, item, itemId, type }) => {
        const approval = approvalsByItemId[itemId];

        if (type === "turnDiff") {
          const items = Array.isArray(turn.items) ? turn.items : [];
          if (items.some((it: any) => String(it?.type ?? "") === "fileChange")) return null;
        }

        if (type === "turnChangesSummary") {
          const summary = (item as any)?.summary as { files: Array<{ path: string; added: number; removed: number }>; diff: string } | undefined;
          const files = Array.isArray(summary?.files) ? summary!.files : [];
          const count = files.length;
          if (!count) return null;
          const label = `${count} file${count === 1 ? "" : "s"} changed`;
          return (
            <div key={itemId} className="mt-2 px-2">
              <div className="flex items-center justify-between border-t border-[var(--vscode-panel-border)] pt-2">
                <div className="text-[12px] font-semibold text-[var(--vscode-foreground)]">{label}</div>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-[12px] font-semibold text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                  onClick={() => {
                    const diff = String(summary?.diff ?? "");
                    if (!diff.trim()) return;
                    window.dispatchEvent(new CustomEvent("xcoding:openCodexDiff", { detail: { title: "Review changes", diff, tabId: `review:${turn.id}` } }));
                  }}
                  title="Review"
                >
                  Review ↗
                </button>
              </div>
              <div className="mt-1 grid gap-1">
                {files.map((f) => {
                  const name = f.path.split("/").pop() ?? f.path;
                  return (
                    <div key={f.path} className="flex items-center justify-between text-[12px] text-[var(--vscode-foreground)]">
                      <div className="min-w-0 truncate">{name}</div>
                      <div className="shrink-0 tabular-nums">
                        {f.added ? <span className="text-[color-mix(in_srgb,#89d185_90%,white)]">{`+${f.added}`}</span> : null}
                        {f.removed ? (
                          <span className={f.added ? "ml-2 text-[color-mix(in_srgb,#f14c4c_90%,white)]" : "text-[color-mix(in_srgb,#f14c4c_90%,white)]"}>
                            {`-${f.removed}`}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        if (type === "userMessage") {
          const content = item?.content;
          return (
            <div key={itemId} className="mb-2 flex justify-end">
              <div className="max-w-[70%] rounded-2xl bg-black/10 px-3 py-2 text-[13px] leading-5 text-[var(--vscode-foreground)]">
                    <UserBlocks content={content} onOpenUrl={onOpenUrl} onOpenImage={onOpenImage} />
              </div>
            </div>
          );
        }

        if (type === "agentMessage") {
          const st = String(turn.status ?? "").toLowerCase();
          const isStreaming = st.includes("progress") || st === "inprogress" || st === "in_progress";
          const text = String(item?.text ?? "");
          return (
            <div key={itemId} className="my-1 py-1">
              {isStreaming ? (
                <pre className="whitespace-pre-wrap text-[13px] leading-6 text-[var(--vscode-foreground)]">{text}</pre>
              ) : (
                <div className="text-[13px] leading-6 text-[var(--vscode-foreground)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents as any}>
                    {text}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          );
        }

        const title = titleForItem(item);
        const open = Object.prototype.hasOwnProperty.call(openByUser, itemId) ? openByUser[itemId] : itemId === autoOpenItemId;
        const turnRunning = getTurnStatusLabel(turn.status).kind === "running";
        const itemStatus = readItemStatus(item);
        const showSweep = turnRunning && itemId === autoOpenItemId;
        const maxH = "var(--xcoding-codex-collapsible-max-h)";

        return (
          <div key={itemId} className="mb-1">
            <div className="px-2 py-0">
              <button
                type="button"
                className={[
                  "group inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] leading-4",
                  "hover:bg-[var(--vscode-toolbar-hoverBackground)] focus:outline-none",
                  open ? "bg-[var(--vscode-toolbar-hoverBackground)]" : "",
                  showSweep ? "xcoding-codex-title-sweep" : "",
                  type === "turnThinking" ? "xcoding-codex-title-blink" : ""
                ].join(" ")}
                onClick={() => {
                  if (type === "turnDiff") {
                    const diff = String((item as any)?.diff ?? "");
                    if (diff.trim()) window.dispatchEvent(new CustomEvent("xcoding:openCodexDiff", { detail: { title: "Codex Diff", diff, tabId: `diff:${turn.id}` } }));
                    return;
                  }
                  if (type === "turnThinking") return;
                  setOpenByUser((prev) => ({ ...prev, [itemId]: !open }));
                }}
                title={title}
              >
                <span className="min-w-0 max-w-full truncate">
                  <span
                    className={[
                      "text-[color-mix(in_srgb,var(--vscode-foreground)_62%,var(--vscode-descriptionForeground))] group-hover:text-[var(--vscode-foreground)]",
                      open ? "text-[var(--vscode-foreground)]" : ""
                    ].join(" ")}
                  >
                    {title || "(untitled)"}
                  </span>
                  <span className="ml-1 inline-flex items-center">
                    <span className="opacity-0 group-hover:opacity-100 text-[var(--vscode-descriptionForeground)] group-hover:text-[var(--vscode-foreground)]">▾</span>
                  </span>
                </span>
              </button>
            </div>

            {type === "turnThinking" ? null : open ? (
              <div
                className="mt-0 max-w-[calc(100%-16px)] overflow-auto rounded bg-black/10 px-2 py-1 text-left text-[11px] leading-4 text-[var(--vscode-foreground)]"
                style={{ maxHeight: maxH as any, overscrollBehavior: "contain" }}
              >
                {type === "agentModeChange" ? (
                  <div className="whitespace-pre-wrap">
                    {t("codexChangedTo")}{" "}
                    <span className="text-[var(--vscode-foreground)]">{renderAgentModeLabel(String(item?.mode ?? ""))}</span>{" "}
                    {t("codexMode")}
                  </div>
                ) : type === "reasoning" ? (
                  <div className="grid gap-2">
                    {readReasoningText(item) ? (
                      <div className="whitespace-pre-wrap">{readReasoningText(item)}</div>
                    ) : (
                      <div className="text-[var(--vscode-descriptionForeground)]">{t("codexNoContent")}</div>
                    )}
                  </div>
                ) : type === "commandExecution" ? (
                  <div className="grid gap-2">
                    {approval ? (
                      <div className="grid gap-2">
                        <div className="text-[11px] text-[var(--vscode-foreground)]">{t("approvalRequired")}</div>
                        {approval?.params?.reason ? <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">Reason: {String(approval.params.reason)}</div> : null}
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
                            type="button"
                            onClick={() => onApprovalDecision(itemId, "accept")}
                          >
                            Accept
                          </button>
                          <button
                            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                            type="button"
                            onClick={() => onApprovalDecision(itemId, "acceptForSession")}
                          >
                            Accept (session)
                          </button>
                          <button
                            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                            type="button"
                            onClick={() => onApprovalDecision(itemId, "decline")}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {readCommandExecutionOutput(item) ? (
                      <TerminalBlock title={String(item?.command ?? "") || undefined} text={readCommandExecutionOutput(item)} />
                    ) : (
                      <div className="text-[var(--vscode-descriptionForeground)]">{t("codexNoOutput")}</div>
                    )}
                  </div>
                ) : type === "fileChange" ? (
                  <div className="grid gap-2">
                    {approval ? (
                      <div className="grid gap-2">
                        <div className="text-[11px] text-[var(--vscode-foreground)]">{t("approvalRequired")}</div>
                        {approval?.params?.reason ? <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">Reason: {String(approval.params.reason)}</div> : null}
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
                            type="button"
                            onClick={() => onApprovalDecision(itemId, "accept")}
                          >
                            Accept
                          </button>
                          <button
                            className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                            type="button"
                            onClick={() => onApprovalDecision(itemId, "decline")}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {Array.isArray(item?.changes) && item.changes.length ? (
                      <div className="grid gap-2">
                        {item.changes.map((c: any, i: number) => (
                          <div key={`${itemId}:${i}`} className="grid gap-1">
                            <div className="truncate text-[11px] text-[var(--vscode-descriptionForeground)]">
                              {String(c?.path ?? "file")} · {String(c?.kind?.type ?? c?.kind ?? "change")}
                            </div>
                            {String(c?.diff ?? "").trim() ? (
                              <DiffLineBlock diff={String(c?.diff ?? "")} />
                            ) : (
                              <div className="text-[var(--vscode-descriptionForeground)]">{t("codexNoDiff")}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[var(--vscode-descriptionForeground)]">{t("codexNoChanges")}</div>
                    )}
                    {turn.snapshot?.status === "available" ? (
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <button
                          className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                          type="button"
                          onClick={() => onTurnRevert?.(turn.id)}
                        >
                          Revert
                        </button>
                        <button
                          className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
                          type="button"
                          onClick={() => onTurnApply?.(turn.id)}
                        >
                          Apply
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : type === "mcpToolCall" ? (
                  <pre className="whitespace-pre-wrap">{formatJson({ arguments: item?.arguments, result: item?.result, error: item?.error })}</pre>
                ) : type === "localToolCall" ? (
                  <div className="grid gap-2">
                    {String(item?.arguments ?? "").trim() ? (
                      <div className="grid gap-1">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{t("arguments")}</div>
                        <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/10 p-2">{String(item.arguments)}</pre>
                      </div>
                    ) : null}
                    {String(item?.input ?? "").trim() ? (
                      <div className="grid gap-1">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{t("input")}</div>
                        <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/10 p-2">{String(item.input)}</pre>
                      </div>
                    ) : null}
                    {String(item?.output ?? "").trim() ? (
                      <div className="grid gap-1">
                        <div className="text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{t("output")}</div>
                        <pre className="overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/10 p-2">{String(item.output)}</pre>
                      </div>
                    ) : null}
                    {!String(item?.arguments ?? "").trim() && !String(item?.input ?? "").trim() && !String(item?.output ?? "").trim() ? (
                      <pre className="whitespace-pre-wrap">{formatJson(item)}</pre>
                    ) : null}
                  </div>
                ) : type === "webSearch" ? (
                  <div className="whitespace-pre-wrap">{String(item?.query ?? "")}</div>
                ) : type === "imageView" ? (
                  <div className="whitespace-pre-wrap">{String(item?.path ?? "")}</div>
                ) : type === "enteredReviewMode" || type === "exitedReviewMode" ? (
                  <div className="whitespace-pre-wrap">{String(item?.review ?? "")}</div>
                ) : type === "turnDiff" ? (
                  <pre className="whitespace-pre-wrap">{String(item?.diff ?? "")}</pre>
                ) : type === "turnError" ? (
                  <pre className="whitespace-pre-wrap">{formatJson(item?.error)}</pre>
                ) : (
                  <pre className="whitespace-pre-wrap">{formatJson(item)}</pre>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
