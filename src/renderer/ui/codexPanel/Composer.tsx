import { Bot, Brain, Check, ChevronDown, Cpu, Image as ImageIcon, Link2, MessageSquare, Paperclip, Plus, ShieldAlert, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { CodexMode, ComposerAttachment, ReasoningEffort } from "./types";
import StatusModal from "./StatusModal";
import { useI18n } from "../i18n";

const localImageDataUrlCache = new Map<string, string>();

function LocalImageThumb({ path, alt, className }: { path?: string; alt?: string; className?: string }) {
  const [url, setUrl] = useState(() => {
    const p = typeof path === "string" ? path : "";
    return p ? localImageDataUrlCache.get(p) ?? "" : "";
  });

  useEffect(() => {
    const p = typeof path === "string" ? path : "";
    if (!p) {
      setUrl("");
      return;
    }
    const cached = localImageDataUrlCache.get(p);
    if (cached) {
      setUrl(cached);
      return;
    }

    let canceled = false;
    void (async () => {
      const res = await window.xcoding.codex.readLocalImageAsDataUrl({ path: p });
      if (canceled) return;
      if (!res.ok || !res.result?.dataUrl) return;
      localImageDataUrlCache.set(p, res.result.dataUrl);
      setUrl(res.result.dataUrl);
    })();

    return () => {
      canceled = true;
    };
  }, [path]);

  if (!url) return null;
  return <img src={url} className={className} alt={alt || "image"} />;
}

function toLocalFileUrl(path: string) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized.startsWith("local-file://")) return normalized;
  if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("data:")) return normalized;
  if (normalized.startsWith("file://")) return `local-file://${normalized.slice("file://".length)}`;
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `local-file://${prefixed}`;
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

function percentUsed(tokensInContextWindow: number | null, contextWindow: number | null) {
  if (typeof tokensInContextWindow !== "number" || typeof contextWindow !== "number") return null;
  if (!Number.isFinite(tokensInContextWindow) || !Number.isFinite(contextWindow)) return null;
  if (contextWindow <= 0) return null;
  const used = Math.max(0, tokensInContextWindow);
  return Math.round(Math.min(100, Math.max(0, (used / contextWindow) * 100)));
}

function formatTokensShort(n: number, numberFormat: Intl.NumberFormat) {
  if (!Number.isFinite(n)) return "?";
  const value = Math.max(0, Math.round(n));
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return numberFormat.format(value);
}

type Props = {
  projectRootPath?: string;
  statusState: "idle" | "starting" | "ready" | "exited" | "error";
  statusError?: string;
  lastStderr: string;
  isBusy: boolean;
  isTurnInProgress: boolean;
  input: string;
  onChangeInput: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRetryStart: () => void;
  onRestart: () => void;
  onOpenSettings: () => void;
  onOpenUrl?: (url: string) => void;
  onOpenImage?: (absPathOrUrl: string) => void;

  attachments: ComposerAttachment[];
  onRemoveAttachment: (id: string) => void;
  onAddFileAttachment: (file: File) => Promise<void>;
  onAddImageAttachment: (file: File) => void;
  onAddImageAttachmentFromPath: (
    path: string,
    name: string,
    meta?: { source?: "picker" | "clipboard"; mime?: string; byteLength?: number }
  ) => void;

  attachFileInputRef: RefObject<HTMLInputElement | null>;
  attachImageInputRef: RefObject<HTMLInputElement | null>;

  isPlusMenuOpen: boolean;
  setIsPlusMenuOpen: (next: boolean | ((v: boolean) => boolean)) => void;
  isSlashMenuOpen: boolean;
  setIsSlashMenuOpen: (next: boolean | ((v: boolean) => boolean)) => void;

  onStartReview: (target: ReviewTarget) => void;
  onRefreshModelsAndConfig: () => void;

  threadId: string | null;
  tokenUsage: any | null;
  rateLimits: any | null;

  hasIdeContext: boolean;
  autoContext: boolean;
  setAutoContext: (next: boolean | ((v: boolean) => boolean)) => void;

  mode: CodexMode;
  onSelectMode: (mode: CodexMode) => void;
  model: string;
  onSelectModel: (model: string) => void;
  effort: ReasoningEffort;
  onSelectEffort: (effort: ReasoningEffort) => void;
  supportedEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>;
  availableModels: Array<{ id: string; model: string; displayName: string; description: string }> | null;
};

type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export default function Composer({
  projectRootPath,
  statusState,
  statusError,
  lastStderr,
  isBusy,
  isTurnInProgress,
  input,
  onChangeInput,
  onSend,
  onStop,
  onRetryStart,
  onRestart,
  onOpenSettings,
  onOpenUrl,
  onOpenImage,
  attachments,
  onRemoveAttachment,
  onAddFileAttachment,
  onAddImageAttachment,
  onAddImageAttachmentFromPath,
  attachFileInputRef,
  attachImageInputRef,
  isPlusMenuOpen,
  setIsPlusMenuOpen,
  isSlashMenuOpen,
  setIsSlashMenuOpen,
  onStartReview,
  onRefreshModelsAndConfig,
  threadId,
  tokenUsage,
  rateLimits,
  hasIdeContext,
  autoContext,
  setAutoContext,
  mode,
  onSelectMode,
  model,
  onSelectModel,
  effort,
  onSelectEffort,
  supportedEfforts,
  availableModels
}: Props) {
  const { t } = useI18n();
  const ready = statusState === "ready";
  const formatBytesShort = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${Math.round(bytes)}B`;
  };
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashView, setSlashView] = useState<"root">("root");
  const [skills, setSkills] = useState<Array<{ name: string; description: string; shortDescription?: string | null; path: string }>>([]);
  const [skillsState, setSkillsState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [pasteError, setPasteError] = useState<string>("");
  const footerRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const [compactPickers, setCompactPickers] = useState(false);

  const numberFormat = useMemo(() => new Intl.NumberFormat(undefined), []);
  const usedTokens = readTokensInContextWindow(tokenUsage);
  const contextWindow = readContextWindow(tokenUsage);
  const usedPercent = percentUsed(usedTokens, contextWindow);

  const modeLabel = useMemo(() => {
    if (mode === "auto") return "Agent";
    if (mode === "read-only") return "Chat";
    if (mode === "full-access") return "Agent (full access)";
    return String(mode);
  }, [mode]);

  const modelLabel = useMemo(() => {
    const m = availableModels?.find((x) => x.model === model || x.id === model);
    return m?.displayName || m?.model || m?.id || model;
  }, [availableModels, model]);

  const effortLabel = useMemo(() => {
    if (effort === "none") return "None";
    if (effort === "xhigh") return "XHigh";
    return effort.charAt(0).toUpperCase() + effort.slice(1);
  }, [effort]);

  useEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;

    let raf = 0;
    const measure = () => {
      // Overflow-based detection can be unstable under flex/ellipsis; use width threshold for predictable UX.
      setCompactPickers(el.clientWidth < 360);
    };

    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    measure();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const filteredCommands = useMemo(() => {
    const q = slashQuery.trim().toLowerCase();
    const commands = [
      { key: "status", label: "Status", description: "Session / Context / Rate limit", disabled: !projectRootPath }
    ];
    if (!q) return commands;
    return commands.filter((c) => `${c.label}\n${c.description}`.toLowerCase().includes(q));
  }, [slashQuery, projectRootPath, ready, isBusy, isTurnInProgress]);

  const filteredSkills = useMemo(() => {
    const q = slashQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => `${s.name}\n${s.description}\n${s.shortDescription ?? ""}\n${s.path}`.toLowerCase().includes(q));
  }, [skills, slashQuery]);

  const [openPicker, setOpenPicker] = useState<null | "mode" | "model" | "effort">(null);

  const DropdownSelect = ({
    id,
    value,
    label,
    disabled,
    compact,
    fallbackIcon,
    options,
    className,
    maxMenuHeight = 320,
    onChange
  }: {
    id: "mode" | "model" | "effort";
    value: string;
    label: string;
    disabled: boolean;
    compact?: boolean;
    fallbackIcon?: ReactNode;
    options: Array<{ value: string; label: string; icon?: ReactNode }>;
    className?: string;
    maxMenuHeight?: number;
    onChange: (next: string) => void;
  }) => {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const open = openPicker === id;
    const selectedOpt = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
    const triggerIcon = selectedOpt?.icon ?? fallbackIcon ?? null;
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    useEffect(() => {
      if (!open) return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpenPicker(null);
      };
      document.addEventListener("keydown", onKeyDown);
      return () => {
        document.removeEventListener("keydown", onKeyDown);
      };
    }, [open]);

    useEffect(() => {
      if (!open) return;
      const root = rootRef.current;
      if (!root) return;
      const btn = root.querySelector("button");
      if (btn) (btn as HTMLButtonElement).focus();
    }, [open]);

    const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; minWidth: number } | null>(null);
    useEffect(() => {
      if (!open) return;
      const root = rootRef.current;
      if (!root) return;
      const btn = root.querySelector("button");
      if (!btn) return;
      const r = (btn as HTMLElement).getBoundingClientRect();
      setAnchorRect(r);
      const minWidth = Math.max(180, Math.round(r.width));
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - minWidth - margin);
      const left = Math.min(Math.max(margin, Math.round(r.left)), maxLeft);
      const top = Math.round(r.bottom + 4); // default: directly below trigger
      setMenuStyle({ left, top, minWidth });
    }, [open, compact, label, value, maxMenuHeight]);

    useEffect(() => {
      if (!open) return;
      if (!menuStyle || !anchorRect) return;
      const el = menuRef.current;
      if (!el) return;
      const margin = 8;
      const menuH = Math.ceil(el.getBoundingClientRect().height);
      const desiredBelowTop = Math.round(anchorRect.bottom + 4);
      const desiredAboveTop = Math.round(anchorRect.top - 4 - menuH);
      const fitsBelow = desiredBelowTop + menuH <= window.innerHeight - margin;
      const top = fitsBelow ? desiredBelowTop : Math.max(margin, desiredAboveTop);
      if (top !== menuStyle.top) setMenuStyle({ ...menuStyle, top });
    }, [open, menuStyle, anchorRect]);

    return (
      <div ref={rootRef} className={["relative inline-flex shrink-0", className ?? ""].join(" ")}>
        <button
          type="button"
          disabled={disabled}
          title={label}
          onClick={() => setOpenPicker((prev) => (prev === id ? null : id))}
          className={[
            "inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] text-[var(--vscode-foreground)]",
            "hover:bg-[var(--vscode-toolbar-hoverBackground)] focus:bg-[var(--vscode-toolbar-hoverBackground)]",
            "outline-none disabled:opacity-50"
          ].join(" ")}
        >
          {compact ? (
            <span className="inline-flex h-4 w-4 items-center justify-center text-[var(--vscode-descriptionForeground)]">{triggerIcon}</span>
          ) : (
            <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--vscode-descriptionForeground)]" />
        </button>

        {open && menuStyle
          ? createPortal(
              <div
                className="fixed inset-0 z-[9999]"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setOpenPicker(null);
                }}
              >
                <div
                  ref={menuRef}
                  className="fixed overflow-auto rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-lg"
                  style={{ left: menuStyle.left, top: menuStyle.top, minWidth: menuStyle.minWidth, maxHeight: maxMenuHeight }}
                  role="menu"
                >
                  <div className="px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)]">
                    {id === "mode"
                      ? t("switchMode")
                      : id === "model"
                        ? t("chooseModelAndReasoning")
                        : id === "effort"
                          ? t("selectReasoningEffort")
                          : `${t("switchTo")} ${id}`}
                  </div>
                  {options.map((opt) => {
                    const selected = opt.value === value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="menuitem"
                        className={[
                          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                          "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]",
                          selected ? "bg-black/10" : ""
                        ].join(" ")}
                        onClick={() => {
                          setOpenPicker(null);
                          onChange(opt.value);
                        }}
                      >
                        <span className="inline-flex h-4 w-4 items-center justify-center text-[var(--vscode-descriptionForeground)]">
                          {opt.icon ?? null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                        {selected ? <Check className="h-4 w-4 text-[var(--vscode-foreground)]" /> : <span className="h-4 w-4" />}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body
            )
          : null}
      </div>
    );
  };

  useEffect(() => {
    if (isSlashMenuOpen) return;
    setSlashView("root");
    setSlashQuery("");
  }, [isSlashMenuOpen]);

  useEffect(() => {
    if (!isSlashMenuOpen) return;
    if (!projectRootPath || !ready) return;
    if (skillsState === "loading" || skillsState === "ready") return;
    void (async () => {
      setSkillsState("loading");
      try {
        const res = await window.xcoding.codex.skillsList({ cwds: [projectRootPath], forceReload: false });
        if (!res.ok) throw new Error(res.reason || "skills_list_failed");
        const entries = Array.isArray(res.result?.data) ? (res.result.data as any[]) : [];
        const all = entries.flatMap((e) => (Array.isArray(e?.skills) ? e.skills : []));
        const parsed = all
          .map((s: any) => ({
            name: String(s?.name ?? ""),
            description: String(s?.description ?? ""),
            shortDescription:
              typeof s?.shortDescription === "string"
                ? s.shortDescription
                : typeof s?.short_description === "string"
                  ? s.short_description
                  : null,
            path: String(s?.path ?? "")
          }))
          .filter((s: { name: string; description: string; shortDescription?: string | null; path: string }) => s.name && s.path);
        setSkills(parsed);
        setSkillsState("ready");
      } catch {
        setSkillsState("error");
      }
    })();
  }, [isSlashMenuOpen, projectRootPath, ready, skillsState]);

  const closeSlashMenu = () => {
    setIsSlashMenuOpen(false);
    setSlashView("root");
    setSlashQuery("");
  };

  return (
    <div className="relative border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] p-2">
      {!projectRootPath ? (
        <div className="mb-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("codexBindProjectFolder")}</div>
      ) : !ready ? (
        <div className="mb-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
          {statusState === "idle" || statusState === "starting" ? (
            <div>
              {t("codexStarting")}
              <div className="mt-1">
                {t("statusLabel")} {statusState}
              </div>
            </div>
          ) : (
            <div>
              {t("codexNotReady")}
              <div className="mt-1">
                <div>{t("codexCheckAppServer")}</div>
                <div className="mt-1">
                  {t("statusLabel")} {statusState}
                </div>
                {statusError ? (
                  <div className="mt-1">
                    {t("reasonLabel")} {statusError}
                  </div>
                ) : null}
                <div className="mt-1">
                  {t("codexEnvHint")}
                  {t("codexMcpDisableHint")}
                </div>
                <div className="mt-2">
                  <button
                    className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
                    type="button"
                    onClick={onRetryStart}
                  >
                    {t("retry")}
                  </button>
                  <button
                    className="ml-2 rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                    type="button"
                    onClick={onRestart}
                  >
                    {t("restartAppServer")}
                  </button>
                  <button
                    className="ml-2 rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    type="button"
                    onClick={onOpenSettings}
                  >
                    {t("settings")}…
                  </button>
                </div>
              </div>
            </div>
          )}
          {lastStderr ? (
            <details className="mt-1">
              <summary className="cursor-pointer">stderr</summary>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[10px]">
                {lastStderr}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <StatusModal open={isStatusOpen} threadId={threadId} tokenUsage={tokenUsage} rateLimits={rateLimits} onClose={() => setIsStatusOpen(false)} />

      <div className="relative flex flex-col gap-2 rounded-2xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-input-background)] px-4 py-3 text-[var(--vscode-input-foreground)]">
        <input
          ref={attachFileInputRef as unknown as Ref<HTMLInputElement>}
          className="hidden"
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void onAddFileAttachment(file);
            e.currentTarget.value = "";
          }}
        />
        <input
          ref={attachImageInputRef as unknown as Ref<HTMLInputElement>}
          className="hidden"
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            onAddImageAttachment(file);
            e.currentTarget.value = "";
          }}
        />

        {attachments.length ? (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-full border border-[var(--vscode-panel-border)] bg-black/10 px-3 py-1 text-[11px] text-[var(--vscode-foreground)] hover:bg-black/15"
                title={a.kind === "localImage" ? a.path : a.path || a.name}
                role="button"
                tabIndex={0}
                onClick={() => onRemoveAttachment(a.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onRemoveAttachment(a.id);
                }}
              >
                {a.kind === "localImage" ? (
                  <button
                    type="button"
                    className="inline-flex h-5 w-5 overflow-hidden rounded bg-black/10"
                    title="Open image"
                    onClick={(e) => {
                      e.stopPropagation();
                      const href = toLocalFileUrl(a.path);
                      if (!href) return;
                      if (onOpenImage) {
                        onOpenImage(href);
                        return;
                      }
                      const open = onOpenUrl ?? ((u: string) => window.open(u, "_blank", "noopener,noreferrer"));
                      open(href);
                    }}
                  >
                    <LocalImageThumb path={a.path} className="h-5 w-5 object-cover" alt={a.name} />
                  </button>
                ) : (
                  <Paperclip className="h-3.5 w-3.5" />
                )}
                <span className="max-w-[220px] truncate">{a.name}</span>
                {typeof (a as any).byteLength === "number" && (a as any).byteLength > 0 ? (
                  <span className="shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">{formatBytesShort((a as any).byteLength)}</span>
                ) : null}
                <span className="text-[var(--vscode-descriptionForeground)]">×</span>
              </div>
            ))}
          </div>
        ) : null}

        {pasteError ? <div className="px-1 text-[11px] text-[color-mix(in_srgb,#f14c4c_90%,white)]">{pasteError}</div> : null}

        <textarea
          className="min-h-[72px] w-full resize-none bg-transparent px-2 py-1 text-[13px] text-[var(--vscode-input-foreground)] outline-none disabled:opacity-60"
          placeholder={t("codexAskPlaceholder")}
          value={input}
          disabled={!projectRootPath || !ready || isBusy}
          onChange={(e) => onChangeInput(e.target.value)}
          onPaste={(e) => {
            if (!projectRootPath || !ready) return;
            const items = Array.from(e.clipboardData?.items ?? []);
            const images: File[] = [];
            for (const item of items) {
              if (item.kind !== "file") continue;
              if (!String(item.type ?? "").startsWith("image/")) continue;
              const file = item.getAsFile();
              if (file) images.push(file);
            }
            if (!images.length) return;

            e.preventDefault();
            setPasteError("");

            const MAX_IMAGES = 4;
            const MAX_SINGLE_BYTES = 10 * 1024 * 1024;
            const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

            const selected = images.slice(0, MAX_IMAGES);
            const total = selected.reduce((sum, f) => sum + (typeof f.size === "number" ? f.size : 0), 0);
            const tooLargeSingle = selected.find((f) => (typeof f.size === "number" ? f.size : 0) > MAX_SINGLE_BYTES);
            if (tooLargeSingle) {
              setPasteError(`${t("pasteImageTooLargeSingle")}${tooLargeSingle.name || "image"}`);
              return;
            }
            if (total > MAX_TOTAL_BYTES) {
              setPasteError(t("pasteImageTooLargeTotal"));
              return;
            }

            void (async () => {
              for (const file of selected) {
                try {
                  const buf = await file.arrayBuffer();
                  const mime = file.type || "image/png";
                  const res = await window.xcoding.codex.writeImageAttachment({
                    bytes: buf,
                    mime,
                    suggestedName: file.name || "clipboard"
                  });
                  if (!res.ok || !res.result?.path) throw new Error(res.reason || "write_failed");
                  const name = file.name && file.name !== "blob" ? file.name : `clipboard.${mime === "image/jpeg" ? "jpg" : "png"}`;
                  onAddImageAttachmentFromPath(res.result.path, name, { source: "clipboard", mime, byteLength: res.result.byteLength });
                } catch {
                  setPasteError(t("pasteImageWriteFailed"));
                  return;
                }
              }
            })();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if ((e.nativeEvent as any)?.isComposing || (e as any).isComposing) return; // don't send while IME composing
            if (e.shiftKey) return;
            // While a turn is streaming, Enter should only add a newline (no send / no stop).
            if (isTurnInProgress) return;
            if (!input.trim() || !projectRootPath || !ready || isBusy) return;
            e.preventDefault();
            onSend();
          }}
          onDragOver={(e) => {
            const dt = e.dataTransfer;
            if (!dt) return;
            if (dt.types.includes("application/x-xcoding-relpath") || dt.types.includes("text/plain") || dt.files?.length) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            const dt = e.dataTransfer;
            if (!dt) return;
            if (dt.types.includes("application/x-xcoding-relpath") || dt.types.includes("text/plain")) {
              e.preventDefault();
              const rel = dt.getData("application/x-xcoding-relpath") || dt.getData("text/plain");
              const cleaned = rel.trim();
              if (cleaned) onChangeInput(input ? `${input}\n${cleaned}` : cleaned);
              return;
            }
            if (dt.files && dt.files.length) {
              e.preventDefault();
              const files = Array.from(dt.files);
              files.forEach((file) => {
                void onAddFileAttachment(file);
              });
            }
          }}
        />

        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-1">
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
              type="button"
              title={t("attach")}
              disabled={!projectRootPath || !ready || isBusy}
              onClick={() => {
                setIsSlashMenuOpen(false);
                setIsPlusMenuOpen((v) => !v);
              }}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
              type="button"
              title="/"
              disabled={!projectRootPath || !ready || isBusy}
              onClick={() => {
                setIsPlusMenuOpen(false);
                setIsSlashMenuOpen((v) => !v);
              }}
            >
              /
            </button>
            <button
              className={[
                "ml-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px]",
                autoContext
                  ? "bg-[color-mix(in_srgb,var(--vscode-focusBorder)_22%,transparent)] text-[var(--vscode-foreground)]"
                  : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              ].join(" ")}
              type="button"
              disabled={!projectRootPath || !ready || isBusy}
              onClick={() => setAutoContext((v) => !v)}
              title={t("autoContext")}
            >
              <Link2 className="h-3.5 w-3.5 text-[var(--vscode-descriptionForeground)]" />
              Auto context
            </button>
          </div>

          <button
            className="rounded-full bg-[var(--vscode-button-background)] p-2 text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
            disabled={!projectRootPath || !ready || (!isTurnInProgress && (!input.trim() || isBusy))}
            onClick={isTurnInProgress ? onStop : onSend}
            type="button"
            title={isTurnInProgress ? "Stop" : "Send"}
          >
            {isTurnInProgress ? <Square className="h-4 w-4" /> : "↑"}
          </button>
        </div>

        {isPlusMenuOpen ? (
          <div className="absolute bottom-full left-2 mb-2 w-[260px] overflow-hidden rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-lg">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
              type="button"
              onClick={() => {
                setIsPlusMenuOpen(false);
                attachFileInputRef.current?.click();
              }}
            >
              <Paperclip className="h-4 w-4 text-[var(--vscode-descriptionForeground)]" />
              Attach file…
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
              type="button"
              onClick={() => {
                setIsPlusMenuOpen(false);
                attachImageInputRef.current?.click();
              }}
            >
              <ImageIcon className="h-4 w-4 text-[var(--vscode-descriptionForeground)]" />
              Attach image…
            </button>
          </div>
        ) : null}

        {isSlashMenuOpen ? (
          <div className="absolute bottom-full left-2 mb-2 w-[360px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-2xl">
            <div className="border-b border-[var(--vscode-panel-border)] p-2">
              <input
                className="w-full rounded bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                placeholder="Search commands and skills"
                value={slashQuery}
                onChange={(e) => setSlashQuery(e.target.value)}
              />
            </div>

            <div className="max-h-[35vh] overflow-auto p-1">
              <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{t("commands")}</div>
              {filteredCommands.map((c) => (
                <button
                  key={c.key}
                  className={["w-full rounded px-2 py-2 text-left", c.disabled ? "opacity-50" : "hover:bg-[var(--vscode-list-hoverBackground)]"].join(" ")}
                  type="button"
                  disabled={c.disabled}
                  onClick={() => {
                    closeSlashMenu();
                    if (c.key === "status") setIsStatusOpen(true);
                  }}
                >
                  <div className="text-[12px] text-[var(--vscode-foreground)]">{c.label}</div>
                  <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">{c.description}</div>
                </button>
              ))}

              <div className="mt-2 px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">{t("skills")}</div>
              {skillsState === "loading" ? (
                <div className="px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("loadingSkills")}</div>
              ) : skillsState === "error" ? (
                <div className="px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("failedToLoadSkills")}</div>
              ) : filteredSkills.length === 0 ? (
                <div className="px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">{t("noSkillsFound")}</div>
              ) : (
                filteredSkills.map((s) => (
                  <button
                    key={`${s.name}:${s.path}`}
                    className="w-full rounded px-2 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                    type="button"
                    onClick={() => {
                      const token = `[$${s.name}](${s.path})`;
                      const next = input.trim() ? `${input.trimEnd()}\n${token}` : token;
                      onChangeInput(next);
                      closeSlashMenu();
                    }}
                    title={s.path}
                  >
                    <div className="text-[12px] text-[var(--vscode-foreground)]">{s.name}</div>
                    <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">{s.shortDescription || s.description}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
	      </div>

	      <div ref={footerRef} className="mt-2 flex items-center justify-between gap-2 px-1">
	        <div ref={controlsRef} className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
	          <DropdownSelect
	            id="mode"
	            value={mode}
	            label={modeLabel}
	            disabled={!projectRootPath || isBusy || isTurnInProgress}
	            compact={compactPickers}
	            onChange={(v) => onSelectMode(v as CodexMode)}
	            options={[
	              { value: "read-only", label: "Chat", icon: <MessageSquare className="h-4 w-4" /> },
	              { value: "auto", label: "Agent", icon: <Bot className="h-4 w-4" /> },
	              { value: "full-access", label: "Agent (full access)", icon: <ShieldAlert className="h-4 w-4" /> }
	            ]}
	            className="shrink-0"
	          />

	          <DropdownSelect
	            id="model"
	            value={model}
	            label={modelLabel}
	            disabled={!projectRootPath || isBusy || isTurnInProgress}
	            compact={compactPickers}
	            fallbackIcon={<Cpu className="h-4 w-4" />}
	            onChange={(v) => onSelectModel(v)}
	            options={
	              availableModels?.length
	                ? availableModels.map((m) => ({
	                    value: m.model || m.id,
	                    label: m.displayName || m.model || m.id
	                  }))
	                : [
	                    { value: "gpt-5.2", label: "GPT-5.2" },
	                    { value: "gpt-5.1", label: "GPT-5.1" },
	                    { value: "gpt-4o", label: "GPT-4o" },
	                    { value: "gpt-4o-mini", label: "GPT-4o mini" }
	                  ]
	            }
	            className="shrink-0"
	            maxMenuHeight={360}
	          />

	          <DropdownSelect
	            id="effort"
	            value={effort}
	            label={effortLabel}
	            disabled={!projectRootPath || isBusy || isTurnInProgress}
	            compact={compactPickers}
	            fallbackIcon={<Brain className="h-4 w-4" />}
	            onChange={(v) => onSelectEffort(v as ReasoningEffort)}
	            options={supportedEfforts.map((o) => ({
	              value: o.reasoningEffort,
	              label:
	                o.reasoningEffort === "none"
	                  ? "None"
	                  : o.reasoningEffort === "xhigh"
	                    ? "XHigh"
	                    : o.reasoningEffort.charAt(0).toUpperCase() + o.reasoningEffort.slice(1)
	            }))}
	            className="shrink-0"
	          />
	        </div>

	        {typeof usedTokens === "number" && typeof contextWindow === "number" && typeof usedPercent === "number" ? (
	          <div className="group relative shrink-0 flex items-center gap-1 text-[11px] text-[var(--vscode-foreground)]">
	            <div
	              className={[
	                "pointer-events-none absolute right-0 top-0 -translate-y-full",
	                "hidden group-hover:block",
	                "mb-2 w-[220px] rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-lg"
	              ].join(" ")}
	            >
	              <div className="p-2 text-[11px] leading-4 text-[var(--vscode-foreground)]">
	                <div className="text-[var(--vscode-descriptionForeground)]">Context window:</div>
	                <div className="mt-0.5">{formatTokensShort(contextWindow, numberFormat)} tokens</div>
	                <div className="text-[var(--vscode-descriptionForeground)]">
	                  {formatTokensShort(usedTokens, numberFormat)} / {formatTokensShort(contextWindow, numberFormat)} tokens used
	                </div>
	                <div className="mt-1 flex items-center justify-end gap-1 text-[var(--vscode-descriptionForeground)]">
	                  <span className="font-semibold">{usedPercent}%</span>
	                </div>
	              </div>
	            </div>

	            <svg className="h-5 w-5" viewBox="0 0 36 36" aria-hidden="true">
	              <circle cx="18" cy="18" r="15.5" fill="none" stroke="color-mix(in srgb, white 22%, transparent)" strokeWidth="3" />
	              <circle
	                cx="18"
	                cy="18"
	                r="15.5"
	                fill="none"
	                stroke="white"
	                strokeWidth="3"
	                strokeLinecap="round"
	                strokeDasharray={`${Math.round((usedPercent / 100) * 97.4)} 97.4`}
	                transform="rotate(-90 18 18)"
	                opacity={0.9}
	              />
	            </svg>
	            <div className="font-semibold">{usedPercent}%</div>
	          </div>
	        ) : null}
	      </div>
	    </div>
	  );
}
