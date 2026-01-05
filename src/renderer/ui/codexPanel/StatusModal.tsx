import { useMemo } from "react";
import { useI18n } from "../i18n";

// Keep aligned with Codex CLI's TokenUsage.percent_of_context_window_remaining():
// reference/codex/codex-rs/protocol/src/protocol.rs
const BASELINE_TOKENS = 12_000;

type Props = {
  open: boolean;
  threadId: string | null;
  tokenUsage: any | null;
  rateLimits: any | null;
  onClose: () => void;
};

function formatContextWindowShort(n: number, numberFormat: Intl.NumberFormat) {
  if (!Number.isFinite(n)) return "?";
  const value = Math.max(0, Math.round(n));
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return numberFormat.format(value);
}

function readTokensInContextWindow(tokenUsage: any): number | null {
  return typeof tokenUsage?.last?.totalTokens === "number"
    ? tokenUsage.last.totalTokens
    : typeof tokenUsage?.last?.total_tokens === "number"
      ? tokenUsage.last.total_tokens
      : typeof tokenUsage?.total?.totalTokens === "number"
        ? tokenUsage.total.totalTokens
        : typeof tokenUsage?.total?.total_tokens === "number"
          ? tokenUsage.total.total_tokens
          : null;
}

function readContextWindow(tokenUsage: any): number | null {
  return typeof tokenUsage?.modelContextWindow === "number"
    ? tokenUsage.modelContextWindow
    : typeof tokenUsage?.model_context_window === "number"
      ? tokenUsage.model_context_window
      : null;
}

function percentLeft(tokensInContextWindow: number | null, contextWindow: number | null) {
  if (typeof tokensInContextWindow !== "number" || typeof contextWindow !== "number") return null;
  if (!Number.isFinite(tokensInContextWindow) || !Number.isFinite(contextWindow)) return null;
  if (contextWindow <= BASELINE_TOKENS) return 0;
  const effectiveWindow = contextWindow - BASELINE_TOKENS;
  const used = Math.max(0, tokensInContextWindow - BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  return Math.round(Math.min(100, Math.max(0, (remaining / effectiveWindow) * 100)));
}

function formatRateLimitOneLine(rateLimits: any) {
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;
  const pieces: string[] = [];
  if (primary && typeof primary.usedPercent === "number" && Number.isFinite(primary.usedPercent)) {
    pieces.push(`Primary ${Math.round(primary.usedPercent)}%`);
  }
  if (secondary && typeof secondary.usedPercent === "number" && Number.isFinite(secondary.usedPercent)) {
    pieces.push(`Secondary ${Math.round(secondary.usedPercent)}%`);
  }
  return pieces.length ? pieces.join(" · ") : "Unavailable";
}

export default function StatusModal({ open, threadId, tokenUsage, rateLimits, onClose }: Props) {
  const numberFormat = useMemo(() => new Intl.NumberFormat(undefined), []);
  const { t } = useI18n();
  if (!open) return null;

  const usedTokens = readTokensInContextWindow(tokenUsage);
  const contextWindow = readContextWindow(tokenUsage);
  const left = percentLeft(usedTokens, contextWindow);

  const contextText =
    typeof left === "number" && typeof usedTokens === "number" && typeof contextWindow === "number"
      ? `${left}% left (${numberFormat.format(usedTokens)} used / ${formatContextWindowShort(contextWindow, numberFormat)})`
      : t("unavailable");

  return (
    <div
      className="absolute bottom-full left-2 right-2 z-50 mb-2 flex max-h-[35vh] min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] shadow-2xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-3 py-2">
        <div className="text-[12px] font-semibold text-[var(--vscode-foreground)]">{t("status")}</div>
        <button
          className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
          type="button"
          onClick={onClose}
        >
          {t("close")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12px] text-[var(--vscode-foreground)]">
        <div className="rounded border border-[var(--vscode-panel-border)] bg-black/10 p-3">
          <div className="grid grid-cols-[90px,1fr] gap-x-2 gap-y-1 text-[12px]">
            <div className="text-[var(--vscode-descriptionForeground)]">{t("session")}:</div>
            <div className="break-all">{threadId || t("unavailable")}</div>

            <div className="text-[var(--vscode-descriptionForeground)]">{t("context")}:</div>
            <div className="break-all">{contextText}</div>

            <div className="text-[var(--vscode-descriptionForeground)]">{t("rateLimit")}:</div>
            <div className="break-all">{formatRateLimitOneLine(rateLimits)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
