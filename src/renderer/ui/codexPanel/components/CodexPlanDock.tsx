import { Check, ChevronDown, ChevronUp, Circle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../i18n";

type PlanStep = { step: string; status: string };
type Plan = { explanation?: string | null; steps: PlanStep[] };

type Props = {
  plan: Plan;
  isTurnInProgress: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onHeightChange?: (height: number) => void;
};

function normalizeStatus(raw: unknown) {
  const s = String(raw ?? "").toLowerCase();
  if (s === "inprogress" || s === "in_progress" || s.includes("progress")) return "in_progress";
  if (s === "completed" || s === "complete" || s === "done" || s.includes("complete")) return "completed";
  if (s === "pending") return "pending";
  return "unknown";
}

function DotsSpinner({ animate }: { animate: boolean }) {
  return (
    <div className={["relative h-4 w-4", animate ? "animate-spin" : ""].join(" ")}>
      <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-[var(--vscode-descriptionForeground)]" />
      <span className="absolute right-0 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--vscode-descriptionForeground)]" />
      <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[var(--vscode-descriptionForeground)]" />
      <span className="absolute left-0 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--vscode-descriptionForeground)]" />
    </div>
  );
}

function StepStatusIcon({ status, animate }: { status: string; animate: boolean }) {
  const s = normalizeStatus(status);
  if (s === "completed") {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[color-mix(in_srgb,#89d185_85%,var(--vscode-panel-border))] text-[color-mix(in_srgb,#89d185_95%,white)]">
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (s === "in_progress") {
    return <Loader2 className={["h-4 w-4 text-[color-mix(in_srgb,var(--vscode-focusBorder)_85%,white)]", animate ? "animate-spin" : ""].join(" ")} />;
  }
  return <Circle className="h-4 w-4 text-[var(--vscode-descriptionForeground)]" />;
}

export default function CodexPlanDock({ plan, isTurnInProgress, isOpen, onOpenChange, onHeightChange }: Props) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];

  const summary = useMemo(() => {
    const total = steps.length;
    if (!total) return { current: 0, total: 0, title: "Plan", hasInProgress: false };

    const idxInProgress = steps.findIndex((s) => normalizeStatus(s?.status) === "in_progress");
    const idxPending = steps.findIndex((s) => normalizeStatus(s?.status) === "pending");
    const idxCompleted = (() => {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (normalizeStatus(steps[i]?.status) === "completed") return i;
      }
      return -1;
    })();

    const idx = idxInProgress >= 0 ? idxInProgress : idxPending >= 0 ? idxPending : idxCompleted >= 0 ? idxCompleted : 0;
    const title = String(steps[idx]?.step ?? "").trim() || "Plan";
    return { current: idx + 1, total, title, hasInProgress: idxInProgress >= 0 };
  }, [steps]);

  const shouldAnimate = isTurnInProgress && summary.hasInProgress;

  useEffect(() => {
    if (!onHeightChange) return;
    const el = rootRef.current;
    if (!el) return;

    let raf = 0;
    const report = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      onHeightChange(rect.height);
    };

    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(report);
    });
    ro.observe(el);
    report();

    return () => {
      ro.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [onHeightChange, isOpen, steps.length]);

  return (
    <div ref={rootRef} className="absolute inset-x-2 bottom-2 z-30">
      <div className="rounded-2xl border border-[var(--vscode-panel-border)] bg-[color-mix(in_srgb,var(--vscode-input-background)_82%,black)] shadow-2xl">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
          onClick={() => onOpenChange(!isOpen)}
          title={t("plan")}
        >
          <div className="flex min-w-0 items-center gap-2">
            <DotsSpinner animate={shouldAnimate} />
            <div className="min-w-0 truncate text-[12px] font-semibold text-[var(--vscode-foreground)]">
              {summary.total ? `${summary.current}/${summary.total} ${summary.title}` : t("plan")}
            </div>
          </div>
          <div className="shrink-0 text-[var(--vscode-descriptionForeground)]">
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </div>
        </button>

        {isOpen ? (
          <div className="border-t border-[color-mix(in_srgb,var(--vscode-panel-border)_60%,transparent)] px-3 py-2">
            {plan?.explanation ? (
              <div className="mb-2 text-[11px] leading-4 text-[var(--vscode-descriptionForeground)]">{String(plan.explanation)}</div>
            ) : null}

            <div className="grid gap-1 overflow-auto pr-1" style={{ maxHeight: "var(--xcoding-codex-collapsible-max-h)" as any }}>
              {steps.map((s, idx) => {
                const st = normalizeStatus(s?.status);
                const isActive = st === "in_progress";
                return (
                  <div
                    key={`${idx}:${String(s?.step ?? "")}`}
                    className={[
                      "flex items-start gap-2 rounded px-1 py-1",
                      isActive ? "bg-black/10" : "hover:bg-black/5"
                    ].join(" ")}
                  >
                    <div className="mt-[1px] shrink-0">
                      <StepStatusIcon status={String(s?.status ?? "")} animate={shouldAnimate && isActive} />
                    </div>
                    <div className="w-5 shrink-0 text-right tabular-nums text-[11px] leading-4 text-[var(--vscode-descriptionForeground)]">
                      {idx + 1}
                    </div>
                    <div className="min-w-0 flex-1 text-[12px] leading-5 text-[var(--vscode-foreground)]">{String(s?.step ?? "")}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
