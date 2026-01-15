import { useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { AiStatus } from "./appTypes";

type VisibleSlot = { slot: number; project: { id: string; name: string; path: string } | null | undefined };

type Props = {
  t: (key: any) => string;
  isSingleProjectWindow: boolean;

  visualOrderedProjectSlots: Array<{ slot: number; projectId?: string }>;
  visibleProjectSlotsForWindow: VisibleSlot[];
  projectIndexBySlot: Map<number, number>;

  projectRowRefs: MutableRefObject<Record<number, HTMLDivElement | null>>;
  aiBySlot: Record<number, AiStatus>;
  activeProjectSlot: number;
  draggingSlot: number | null;
  setActiveProjectSlot: (slot: number) => void;

  onProjectContextMenuOpenNewWindow: (slot: number) => void;
  onCloseProjectSlot: (slot: number) => void;
  onOpenProjectPicker: () => void;

  onDragStartProject: (e: DragEvent, slot: number) => void;
  onDragEndProject: (e: DragEvent, slot: number) => void;
  onDragOverProject: (e: DragEvent) => void;
  onDropProject: (e: DragEvent, slot: number) => void;
};

export default function ProjectSidebar(props: Props) {
  const hoverDelayMs = 350;
  const [hoverTip, setHoverTip] = useState<null | { path: string; left: number; top: number }>(null);
  const hoverTipMaxWidthPx = 420;
  const hoverTimerRef = useRef<number | null>(null);
  const canPortal = typeof document !== "undefined" && Boolean(document.body);
  const [menu, setMenu] = useState<null | { slot: number; path: string; x: number; y: number }>(null);
  const focusRequestedRef = useRef(false);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const fileManagerLabel = useMemo(() => {
    const platform = ((navigator as any).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "").toLowerCase();
    if (platform.includes("mac")) return props.t("revealInFinder");
    if (platform.includes("win")) return props.t("revealInExplorer");
    return props.t("revealInFileManager");
  }, [props.t]);

  const clearHoverTimer = () => {
    const timer = hoverTimerRef.current;
    if (timer != null) window.clearTimeout(timer);
    hoverTimerRef.current = null;
  };

  useEffect(() => {
    return () => clearHoverTimer();
  }, []);

  const hoverTipPortal = useMemo(() => {
    if (!hoverTip || !canPortal) return null;
    return createPortal(
      <div
        className={[
          "pointer-events-none fixed z-[1000]",
          "whitespace-pre-wrap break-all rounded-lg border border-[var(--vscode-input-border)]",
          "bg-[color-mix(in_srgb,var(--vscode-sideBar-background)_92%,transparent)] px-2 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur-xl",
          "font-mono text-[11px] leading-5 text-[var(--vscode-foreground)]"
        ].join(" ")}
        style={{ left: hoverTip.left, top: hoverTip.top, maxWidth: hoverTipMaxWidthPx }}
        role="tooltip"
      >
        {hoverTip.path}
      </div>,
      document.body
    );
  }, [canPortal, hoverTip]);

  useEffect(() => {
    if (!hoverTip) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearHoverTimer();
        setHoverTip(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hoverTip]);

  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu]);

  const handleReveal = async (fullPath: string) => {
    const reveal = (window as any)?.xcoding?.os?.revealInFileManager;
    if (typeof reveal === "function") {
      await reveal(fullPath);
      setMenu(null);
      return;
    }
    const openExternal = (window as any)?.xcoding?.os?.openExternal;
    if (typeof openExternal === "function") {
      await openExternal(`file://${fullPath}`);
    }
    await window.xcoding.os.copyText(fullPath);
    setMenu(null);
  };

  const handleCopyPath = async (fullPath: string) => {
    await window.xcoding.os.copyText(fullPath);
    setMenu(null);
  };

  return (
    <aside className="flex w-[176px] shrink-0 flex-col bg-transparent">
      <div className="flex h-10 items-center justify-between px-3">
        <div className="text-[11px] font-semibold tracking-wide text-[var(--vscode-activityBar-foreground)] opacity-60">{props.t("switcher")}</div>
      </div>

      <div
        className="min-h-0 flex flex-1 flex-col overflow-auto p-2"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("application/x-xcoding-project-slot")) return;
          if (focusRequestedRef.current) return;
          focusRequestedRef.current = true;
          const focusWin = (window as any)?.xcoding?.window?.focus;
          if (typeof focusWin === "function") {
            void focusWin();
          } else {
            window.focus();
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("application/x-xcoding-project-slot")) return;
          if (!document.hasFocus()) {
            const focusWin = (window as any)?.xcoding?.window?.focus;
            if (typeof focusWin === "function") void focusWin();
            else window.focus();
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget !== e.target) return;
          focusRequestedRef.current = false;
          setDragOverSlot(null);
        }}
        onDrop={() => {
          focusRequestedRef.current = false;
          setDragOverSlot(null);
        }}
      >
        {props.visualOrderedProjectSlots.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-3 text-sm text-[var(--vscode-descriptionForeground)]">
            {props.t("noRecentProjects")}
          </div>
        ) : null}

        {props.visibleProjectSlotsForWindow.map(({ slot, project }, index) => {
          const isActive = slot === props.activeProjectSlot;
          const status = props.aiBySlot[slot];
          const title = project ? project.name : `#${slot}`;
          const subtitle = project ? project.path : "";
          const fullPath = project ? project.path : "";
          const globalIndex = props.projectIndexBySlot.get(slot);
          const hotkeyLabel = `#${index + 1}`;
          const order = globalIndex ?? 999;

          return (
            <div
              key={slot}
              ref={(el) => {
                props.projectRowRefs.current[slot] = el;
              }}
              className={[
                "group relative mb-2 flex items-center rounded-lg px-2 py-3 transition-colors",
                isActive ? "bg-[var(--vscode-list-activeSelectionBackground)] shadow-sm" : "hover:bg-[var(--vscode-list-hoverBackground)]",
                props.draggingSlot === slot ? "opacity-30" : "",
                dragOverSlot === slot ? "ring-1 ring-[var(--vscode-focusBorder)] ring-offset-1 ring-offset-[var(--vscode-editor-background)]" : ""
              ].join(" ")}
              onContextMenu={(e) => {
                if (!fullPath) return;
                e.preventDefault();
                e.stopPropagation();
                clearHoverTimer();
                setHoverTip(null);
                setMenu({ slot, path: fullPath, x: e.clientX, y: e.clientY });
              }}
              onMouseEnter={(e) => {
                if (!fullPath) return;
                clearHoverTimer();
                const el = e.currentTarget as HTMLDivElement | null;
                hoverTimerRef.current = window.setTimeout(() => {
                  if (!el || !el.isConnected) return;
                  const rect = el.getBoundingClientRect();
                  setHoverTip({ path: fullPath, left: rect.left + 8, top: rect.bottom + 6 });
                }, hoverDelayMs);
              }}
              onMouseMove={(e) => {
                if (!fullPath) return;
                setHoverTip((prev) => {
                  if (!prev || prev.path !== fullPath) return prev;
                  const el = e.currentTarget as HTMLDivElement | null;
                  if (!el || !el.isConnected) return prev;
                  const rect = el.getBoundingClientRect();
                  const nextLeft = rect.left + 8;
                  const nextTop = rect.bottom + 6;
                  if (Math.abs(prev.left - nextLeft) < 0.5 && Math.abs(prev.top - nextTop) < 0.5) return prev;
                  return { ...prev, left: nextLeft, top: nextTop };
                });
              }}
              onMouseLeave={() => {
                clearHoverTimer();
                setHoverTip(null);
              }}
              draggable
              onDragStart={(e) => {
                props.onDragStartProject(e, slot);
              }}
              onDragEnd={(e) => {
                props.onDragEndProject(e, slot);
                setDragOverSlot(null);
              }}
              onDragOver={(e) => {
                if (props.isSingleProjectWindow) return;
                props.onDragOverProject(e);
                setDragOverSlot(slot);
              }}
              onDrop={(e) => {
                if (props.isSingleProjectWindow) return;
                props.onDropProject(e, slot);
                setDragOverSlot(null);
              }}
              data-slot={slot}
              style={{ willChange: "transform", order }}
            >
              <button
                className="min-w-0 flex-1 pr-2 text-left group-hover:pr-7"
                onClick={() => props.setActiveProjectSlot(slot)}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-[12px] font-medium text-[var(--vscode-activityBar-foreground)]">{title}</div>
                  <div className="shrink-0 rounded bg-black/20 px-1.5 py-0.5 text-[10px] text-[var(--vscode-descriptionForeground)]">{hotkeyLabel}</div>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
                  <div className="min-w-0 truncate">
                    {subtitle}
                  </div>
                  <div className="shrink-0">{status === "running" ? "●" : status === "done" ? "✓" : ""}</div>
                </div>
              </button>

              <button
                className="invisible absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] group-hover:visible"
                onClick={() => void props.onCloseProjectSlot(slot)}
                type="button"
                title={props.t("close")}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {menu && canPortal
        ? createPortal(
          <div
            className="fixed inset-0 z-[1200]"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setMenu(null);
            }}
          >
            <div
              className="fixed min-w-[210px] rounded-lg border border-[var(--vscode-panel-border)] bg-[color-mix(in_srgb,var(--vscode-editor-background)_94%,transparent)] text-[12px] text-[var(--vscode-foreground)] shadow-2xl backdrop-blur-xl"
              style={{
                left: Math.max(8, Math.min(menu.x, (window.innerWidth || menu.x) - 240)),
                top: Math.max(8, Math.min(menu.y, (window.innerHeight || menu.y) - 220))
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
                <span className="text-[var(--vscode-foreground)]">{menu.path}</span>
              </div>
              <div className="border-t border-[var(--vscode-panel-border)]" />
              <button
                className="block w-full px-3 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                onClick={() => void handleCopyPath(menu.path)}
                type="button"
              >
                {props.t("copyPath")}
              </button>
              <button
                className="block w-full px-3 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                onClick={() => void handleReveal(menu.path)}
                type="button"
              >
                {fileManagerLabel}
              </button>
              <div className="border-t border-[var(--vscode-panel-border)]" />
              <button
                className="block w-full px-3 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)]"
                onClick={() => {
                  props.onProjectContextMenuOpenNewWindow(menu.slot);
                  setMenu(null);
                }}
                type="button"
              >
                {props.t("openInNewWindow")}
              </button>
            </div>
          </div>,
          document.body
        )
        : null}

      {hoverTipPortal}

      {!props.isSingleProjectWindow ? (
        <div className="border-t border-[var(--vscode-panel-border)] p-2">
          <button
            className="flex h-9 w-full items-center justify-center rounded border border-dashed border-[var(--vscode-panel-border)] text-sm text-[var(--vscode-activityBar-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
            onClick={props.onOpenProjectPicker}
            type="button"
            title={props.t("projectPickerTitle")}
          >
            +
          </button>
        </div>
      ) : null}
    </aside>
  );
}
