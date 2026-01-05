import type { DragEvent, MutableRefObject } from "react";
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
  return (
    <aside className="flex w-[176px] shrink-0 flex-col border-r border-[var(--vscode-panel-border)] bg-[var(--vscode-activityBar-background)]">
      <div className="flex h-10 items-center justify-between border-b border-[var(--vscode-panel-border)] px-2">
        <div className="text-[11px] font-semibold tracking-wide text-[var(--vscode-activityBar-foreground)]">{props.t("switcher")}</div>
      </div>

      <div className="min-h-0 flex flex-1 flex-col overflow-auto p-2">
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
                "group relative mb-1 flex items-center rounded px-1 py-2",
                isActive ? "bg-[var(--vscode-list-activeSelectionBackground)]" : "hover:bg-[var(--vscode-list-hoverBackground)]"
              ].join(" ")}
              draggable={!props.isSingleProjectWindow}
              onDragStart={(e) => {
                if (props.isSingleProjectWindow) return;
                props.onDragStartProject(e, slot);
              }}
              onDragEnd={(e) => {
                if (props.isSingleProjectWindow) return;
                props.onDragEndProject(e, slot);
              }}
              onDragOver={(e) => {
                if (props.isSingleProjectWindow) return;
                props.onDragOverProject(e);
              }}
              onDrop={(e) => {
                if (props.isSingleProjectWindow) return;
                props.onDropProject(e, slot);
              }}
              data-slot={slot}
              style={{ willChange: "transform", order }}
            >
              <button
                className="min-w-0 flex-1 pr-2 text-left group-hover:pr-7"
                onClick={() => props.setActiveProjectSlot(slot)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const ok = window.confirm("Open this project in a new window?");
                  if (!ok) return;
                  props.onProjectContextMenuOpenNewWindow(slot);
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-[12px] font-medium text-[var(--vscode-activityBar-foreground)]">{title}</div>
                  <div className="shrink-0 rounded bg-black/20 px-1.5 py-0.5 text-[10px] text-[var(--vscode-descriptionForeground)]">{hotkeyLabel}</div>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-[var(--vscode-descriptionForeground)]">
                  <div className="min-w-0 truncate">{subtitle}</div>
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
