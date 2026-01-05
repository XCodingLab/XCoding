import { type DragEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ExplorerPanel from "./ExplorerPanel";
import AutoWorkspace from "./AutoWorkspace";
import { I18nContext, type Language, messages } from "./i18n";
import IdeaFlowModal from "./IdeaFlowModal";
import IdeaWorkspace from "./IdeaWorkspace";
import type { LayoutMode, PaneId, SplitIntent } from "./LayoutManager";
import NewProjectWizardModal from "./NewProjectWizardModal";
import ProjectChatPanel from "./ProjectChatPanel";
import ProjectSidebar from "./ProjectSidebar";
import ProjectWorkspaceMain from "./ProjectWorkspaceMain";
import type { TerminalPanelState } from "./TerminalPanel";
import TitleBar from "./TitleBar";
import {
  getSlotProjectId,
  makeEmptySlotUiState,
  normalizeWorkflowStage,
  type AiStatus,
  type AnyTab,
  type PreviewFocusInfo,
  type ProjectsState,
  type SlotUiState,
  type WorkflowStage,
  workflowAllowsExternalAgents
} from "./appTypes";

function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function isMarkdownFilePath(relPath: string) {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

export default function App() {
  const [language, setLanguage] = useState<Language>("en-US");
  const [activeProjectSlot, setActiveProjectSlot] = useState<number>(() => {
    try {
      const url = new URL(window.location.href);
      const raw = url.searchParams.get("slot");
      const parsed = raw ? Number(raw) : 1;
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 8) return parsed;
    } catch {
      // ignore
    }
    return 1;
  });
  const isSingleProjectWindow = useMemo(() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("windowMode") === "single";
    } catch {
      return false;
    }
  }, []);
  const lockedProjectSlotRef = useRef<number>(activeProjectSlot);
  const [detachedSlots, setDetachedSlots] = useState<Set<number>>(() => new Set());

  const [layout, setLayout] = useState<{
    isExplorerVisible: boolean;
    isChatVisible: boolean;
    explorerWidth: number;
    chatWidth: number;
  }>({ isExplorerVisible: true, isChatVisible: true, explorerWidth: 180, chatWidth: 530 });
  const layoutRef = useRef(layout);
  const defaultUiLayoutRef = useRef<typeof layout | null>(null);
  const layoutPersistTimerRef = useRef<number | null>(null);
  const previewFocusRef = useRef<PreviewFocusInfo | null>(null);
  const appliedWorkflowStageBySlotRef = useRef<Record<number, WorkflowStage>>({});
  const lastNonPreviewSelectionBySlotRef = useRef<Record<number, { pane: PaneId; tabId: string } | null>>({});

  const [terminalScrollback, setTerminalScrollback] = useState(1500);
  const [autoApplyAll, setAutoApplyAll] = useState(true);
  const [aiConfig, setAiConfig] = useState<{ apiBase: string; apiKey: string; model: string }>({
    apiBase: "https://api.openai.com",
    apiKey: "",
    model: "gpt-4o-mini"
  });

  async function setLanguageAndPersist(next: Language) {
    setLanguage(next);
    try {
      await window.xcoding.settings.setLanguage(next);
    } catch {
      // ignore
    }
  }

  function setAiConfigAndPersist(next: { apiBase: string; apiKey: string; model: string }) {
    setAiConfig(next);
    void window.xcoding.settings.setAiConfig(next);
  }

  function setAutoApplyAllAndPersist(next: boolean) {
    setAutoApplyAll(next);
    void window.xcoding.settings.setAutoApply(next);
  }

  const [aiBySlot, setAiBySlot] = useState<Record<number, AiStatus>>(() =>
    Object.fromEntries(Array.from({ length: 8 }).map((_, i) => [i + 1, "idle"])) as Record<number, AiStatus>
  );

  const [projectsState, setProjectsState] = useState<ProjectsState>(() => ({
    schemaVersion: 3,
    slotOrder: Array.from({ length: 8 }).map((_, i) => i + 1),
    slots: Array.from({ length: 8 }).map((_, i) => ({ slot: i + 1 })),
    projects: {}
  }));

  const [slotUi, setSlotUi] = useState<Record<number, SlotUiState>>(() => {
    const entries = Array.from({ length: 8 }).map((_, i) => [i + 1, makeEmptySlotUiState()] as const);
    return Object.fromEntries(entries) as Record<number, SlotUiState>;
  });

  const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false);
  const [dragPreviewSlotOrder, setDragPreviewSlotOrder] = useState<number[] | null>(null);
  const [isDraggingTab, setIsDraggingTab] = useState(false);

  const slotUiRef = useRef(slotUi);
  const prevSlotProjectIdRef = useRef<Record<number, string | undefined>>({});
  const draggingSlotRef = useRef<number | null>(null);
  const lastProjectReorderAtRef = useRef<number>(0);
  const dragPreviewSlotOrderRef = useRef<number[] | null>(null);
  const projectReorderStartOrderRef = useRef<number[] | null>(null);
  const projectReorderDidChangeRef = useRef<boolean>(false);
  const projectRowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const projectRowPrevRectsRef = useRef<Record<number, DOMRect>>({});

  useEffect(() => {
    slotUiRef.current = slotUi;
  }, [slotUi]);
  useEffect(() => {
    dragPreviewSlotOrderRef.current = dragPreviewSlotOrder;
  }, [dragPreviewSlotOrder]);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    document.body.classList.toggle("xcoding-tab-dragging", isDraggingTab);
    return () => document.body.classList.remove("xcoding-tab-dragging");
  }, [isDraggingTab]);

  useEffect(() => {
    const onEnd = () => setIsDraggingTab(false);
    window.addEventListener("dragend", onEnd);
    return () => window.removeEventListener("dragend", onEnd);
  }, []);

  useEffect(() => {
    const onWindowDragEnd = () => {
      // If drop didn't land on a row (no onDrop), but the user did reorder during hover,
      // commit the last preview order here to avoid the "snap back" feeling.
      const preview = dragPreviewSlotOrderRef.current;
      const didChange = projectReorderDidChangeRef.current;
      if (didChange && preview && preview.length === 8) {
        const currentOrder =
          projectsState.slotOrder?.length === 8 ? projectsState.slotOrder : Array.from({ length: 8 }).map((_, i) => i + 1);
        if (currentOrder.join(",") !== preview.join(",")) {
          setProjectsState((s) => ({ ...s, slotOrder: preview }));
          void window.xcoding.projects.reorderSlots(preview);
        }
      }

      draggingSlotRef.current = null;
      setDragPreviewSlotOrder(null);
      dragPreviewSlotOrderRef.current = null;
      projectReorderStartOrderRef.current = null;
      projectReorderDidChangeRef.current = false;
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [projectsState.slotOrder]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e as any).isComposing) return;
      const key = e.key.toLowerCase();
      const isMod = e.metaKey || e.ctrlKey;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const isTextInput = tag === "input" || tag === "textarea" || (target as any)?.isContentEditable;
      if (isTextInput) {
        const allowInEditor = Boolean(target?.closest?.(".monaco-editor, .xterm"));
        if (!allowInEditor) return;
      }

      if (!isMod || e.altKey) return;

      if (!e.shiftKey && key === "s") {
        e.preventDefault();
        const pane = activeUi.activePane;
        const activeTabId = activeUi.panes[pane]?.activeTabId;
        const tab = activeUi.panes[pane]?.tabs.find((t) => t.id === activeTabId);
        if (tab && tab.type === "file" && "path" in tab && typeof tab.path === "string") {
          window.dispatchEvent(
            new CustomEvent("xcoding:requestSaveFile", { detail: { slot: activeProjectSlot, path: tab.path } })
          );
        }
        return;
      }

      if (!e.shiftKey && key === "p") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("xcoding:openSearch", { detail: { slot: activeProjectSlot, mode: "files" } }));
        return;
      }
      if (e.shiftKey && key === "f") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("xcoding:openSearch", { detail: { slot: activeProjectSlot, mode: "content" } }));
        return;
      }
      if (!e.shiftKey && key === "`") {
        e.preventDefault();
        toggleOrCreateTerminalPanel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeProjectSlot]);

  const t = useMemo(() => {
    const dictionary = messages[language];
    return (key: keyof typeof dictionary) => dictionary[key];
  }, [language]);

  const activeProjectId = useMemo(() => getSlotProjectId(projectsState, activeProjectSlot), [projectsState, activeProjectSlot]);
  const activeProject = useMemo(
    () => (activeProjectId ? projectsState.projects[activeProjectId] : undefined),
    [activeProjectId, projectsState.projects]
  );
  const activeProjectPath = activeProject?.path;
  const activeUi = slotUi[activeProjectSlot] ?? makeEmptySlotUiState();
  const activeWorkflowStage: WorkflowStage = activeUi.workflowUi?.stage ?? normalizeWorkflowStage(activeProject?.workflow?.stage);
  const activeViewMode: "develop" | "preview" | null = activeWorkflowStage === "preview" ? "preview" : activeWorkflowStage === "develop" ? "develop" : null;
  const isWorkflowPreview = activeWorkflowStage === "preview";
  const isActiveSlotBound = Boolean(activeProjectId);
  // 本期暂时隐藏内置 Chat（自研对话），保留 Claude Code（终端）与 Codex（app-server UI）。
  const allowedAgentViews: Array<SlotUiState["agentView"]> = ["codex", "claude"];

  useEffect(() => {
    (window as any).__xcodingActiveSlot = activeProjectSlot;
    (window as any).__xcodingActiveProjectRoot = activeProjectPath ?? "";
  }, [activeProjectPath, activeProjectSlot]);

  useEffect(() => {
    if (activeProjectId) {
      const layout = projectsState.projects[activeProjectId]?.uiLayout;
      if (layout) {
        setLayout(layout);
        return;
      }
    }
    if (defaultUiLayoutRef.current) setLayout(defaultUiLayoutRef.current);
  }, [activeProjectId, projectsState.projects]);

  useEffect(() => {
    if (!activeProjectId) return;
    const applied = appliedWorkflowStageBySlotRef.current[activeProjectSlot];
    if (applied === activeWorkflowStage) return;
    appliedWorkflowStageBySlotRef.current[activeProjectSlot] = activeWorkflowStage;
    applyWorkflowStageToSlot(activeProjectSlot, activeWorkflowStage);
  }, [activeProjectId, activeProjectSlot, activeWorkflowStage]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (activeWorkflowStage !== "auto") return;

    const debounceRef: { timer: number | null; lastPath: string } = { timer: null, lastPath: "" };
    const shouldIgnore = (p: string) => {
      if (!p) return true;
      const rel = p.replace(/^\/+/, "");
      if (rel.startsWith("node_modules/")) return true;
      if (rel.startsWith(".git/")) return true;
      if (rel.startsWith("dist/")) return true;
      if (rel.startsWith("build/")) return true;
      if (rel.startsWith(".next/")) return true;
      return false;
    };

    const dispose = window.xcoding.events.onProjectEvent((evt) => {
      if (evt.projectId !== activeProjectId) return;
      if (evt.type !== "watcher") return;
      const relPath = typeof (evt as any).path === "string" ? String((evt as any).path) : "";
      if (!relPath || relPath.endsWith("/")) return;
      if (shouldIgnore(relPath)) return;
      debounceRef.lastPath = relPath;
      if (debounceRef.timer != null) window.clearTimeout(debounceRef.timer);
      debounceRef.timer = window.setTimeout(() => {
        debounceRef.timer = null;
        const nextPath = debounceRef.lastPath;
        if (!nextPath) return;
        updateSlot(activeProjectSlot, (s) => ({ ...s, autoFollow: { ...s.autoFollow, activeRelPath: nextPath } }));
      }, 120);
    });

    return () => {
      if (debounceRef.timer != null) window.clearTimeout(debounceRef.timer);
      dispose();
    };
  }, [activeProjectId, activeProjectSlot, activeWorkflowStage]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (activeWorkflowStage !== "idea") return;

    const shouldIgnore = (p: string) => {
      if (!p) return true;
      const rel = p.replace(/^\/+/, "");
      if (rel.startsWith("node_modules/")) return true;
      if (rel.startsWith(".git/")) return true;
      if (rel.startsWith("dist/")) return true;
      if (rel.startsWith("build/")) return true;
      if (rel.startsWith(".next/")) return true;
      return false;
    };

    const dispose = window.xcoding.events.onProjectEvent((evt) => {
      if (evt.projectId !== activeProjectId) return;
      if (evt.type !== "watcher") return;
      const relPath = typeof (evt as any).path === "string" ? String((evt as any).path) : "";
      if (!relPath || relPath.endsWith("/")) return;
      if (shouldIgnore(relPath)) return;
      updateSlot(activeProjectSlot, (s) => {
        const existing = s.ideaFlow?.writtenFiles ?? [];
        if (existing[0] === relPath) return s;
        const next = [relPath, ...existing.filter((x) => x !== relPath)].slice(0, 50);
        return { ...s, ideaFlow: { ...s.ideaFlow, writtenFiles: next } };
      });
    });

    return () => dispose();
  }, [activeProjectId, activeProjectSlot, activeWorkflowStage]);

  const recentProjects = useMemo(() => {
    return Object.values(projectsState.projects).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }, [projectsState.projects]);

  const baseProjectSlots = useMemo(() => {
    const slotOrder =
      projectsState.slotOrder?.length === 8 ? projectsState.slotOrder : Array.from({ length: 8 }).map((_, i) => i + 1);
    return slotOrder
      .map((slot) => {
        const projectId = getSlotProjectId(projectsState, slot);
        return { slot, projectId, project: projectId ? projectsState.projects[projectId] : undefined };
      })
      .filter((e) => Boolean(e.projectId));
  }, [projectsState]);

  const visualSlotOrder = useMemo(() => {
    if (dragPreviewSlotOrder && dragPreviewSlotOrder.length === 8) return dragPreviewSlotOrder;
    if (projectsState.slotOrder?.length === 8) return projectsState.slotOrder;
    return Array.from({ length: 8 }).map((_, i) => i + 1);
  }, [dragPreviewSlotOrder, projectsState.slotOrder]);

  const visualOrderedProjectSlots = useMemo(() => {
    const bySlot = new Map(baseProjectSlots.map((e) => [e.slot, e]));
    return visualSlotOrder.map((slot) => bySlot.get(slot)).filter(Boolean) as typeof baseProjectSlots;
  }, [baseProjectSlots, visualSlotOrder]);

  const projectIndexBySlot = useMemo(() => {
    const map = new Map<number, number>();
    visualOrderedProjectSlots.forEach((e, index) => map.set(e.slot, index));
    return map;
  }, [visualOrderedProjectSlots]);

  const visibleProjectSlotsForWindow = useMemo(() => {
    if (isSingleProjectWindow) return baseProjectSlots.filter(({ slot }) => slot === lockedProjectSlotRef.current);
    return visualOrderedProjectSlots.filter(({ slot }) => !detachedSlots.has(slot));
  }, [baseProjectSlots, detachedSlots, isSingleProjectWindow, visualOrderedProjectSlots]);

  useEffect(() => {
    if (isSingleProjectWindow) return;
    if (!detachedSlots.has(activeProjectSlot)) return;
    const fallback = visibleProjectSlotsForWindow[0]?.slot;
    if (typeof fallback === "number" && fallback !== activeProjectSlot) {
      setActiveProjectSlot(fallback);
      void window.xcoding.projects.setActiveSlot(fallback);
    }
  }, [activeProjectSlot, detachedSlots, isSingleProjectWindow, visibleProjectSlotsForWindow]);

  useLayoutEffect(() => {
    const prevRects = projectRowPrevRectsRef.current;
    const nextRects: Record<number, DOMRect> = {};
    for (const { slot } of baseProjectSlots) {
      const el = projectRowRefs.current[slot];
      if (!el) continue;
      nextRects[slot] = el.getBoundingClientRect();
    }

    for (const { slot } of baseProjectSlots) {
      const el = projectRowRefs.current[slot];
      const prev = prevRects[slot];
      const next = nextRects[slot];
      if (!el || !prev || !next) continue;
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) continue;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.transition = "transform 0s";
      requestAnimationFrame(() => {
        el.style.transform = "translate(0px, 0px)";
        el.style.transition = "transform 160ms ease";
      });
    }

    projectRowPrevRectsRef.current = nextRects;
  }, [baseProjectSlots.map((e) => e.slot).join(","), visualSlotOrder.join(",")]);

  function updateSlot(slot: number, updater: (prev: SlotUiState) => SlotUiState) {
    setSlotUi((prev) => ({ ...prev, [slot]: updater(prev[slot] ?? makeEmptySlotUiState()) }));
  }

  function applyWorkflowStageToSlot(slot: number, stage: WorkflowStage) {
    const WORKFLOW_PREVIEW_TAB_ID = "tab-preview-workflow";
    if (stage === "preview") {
      const ui = slotUiRef.current[slot] ?? makeEmptySlotUiState();
      const activePane = ui.activePane;
      const paneState = ui.panes[activePane];
      const activeTab =
        paneState.tabs.find((t) => t.id === paneState.activeTabId) ?? paneState.tabs[0] ?? null;
      if (activeTab && activeTab.type !== "preview") {
        lastNonPreviewSelectionBySlotRef.current[slot] = { pane: activePane, tabId: activeTab.id };
      }

      updateSlot(slot, (s) => {
        const panes: PaneId[] = ["A", "B", "C"];
        const previewCandidates = panes.flatMap((pane) =>
          s.panes[pane].tabs
            .filter((t) => t.type === "preview")
            .map((tab) => ({ pane, tab: tab as Extract<AnyTab, { type: "preview" }> }))
        );

        const workflowPreview = previewCandidates.find((x) => x.tab.id === WORKFLOW_PREVIEW_TAB_ID) ?? null;
        const preferredExisting =
          workflowPreview ??
          previewCandidates.find((x) => x.pane === s.activePane) ??
          previewCandidates[0] ??
          null;

        if (preferredExisting) {
          return {
            ...s,
            activePane: preferredExisting.pane,
            panes: {
              ...s.panes,
              [preferredExisting.pane]: { ...s.panes[preferredExisting.pane], activeTabId: preferredExisting.tab.id }
            }
          };
        }

        const pane = s.activePane;
        const existingSameId = s.panes[pane].tabs.find((t) => t.id === WORKFLOW_PREVIEW_TAB_ID);
        if (existingSameId) {
          return { ...s, panes: { ...s.panes, [pane]: { ...s.panes[pane], activeTabId: existingSameId.id } } };
        }

        const next: AnyTab = { id: WORKFLOW_PREVIEW_TAB_ID, type: "preview", title: "Preview", url: "about:blank" };
        return {
          ...s,
          activePane: pane,
          panes: { ...s.panes, [pane]: { tabs: [...s.panes[pane].tabs, next], activeTabId: WORKFLOW_PREVIEW_TAB_ID } }
        };
      });
      return;
    }

    // In develop/other stages, previews should not be visible at all.
    // Best-effort cleanup: destroy any existing BrowserViews for preview tabs.
    const currentUi = slotUiRef.current[slot];
    if (currentUi) {
      const previewIds = new Set<string>();
      (["A", "B", "C"] as const).forEach((pane) => {
        currentUi.panes[pane].tabs.forEach((tab) => {
          if (tab.type === "preview") previewIds.add(tab.id);
        });
      });
      previewIds.forEach((previewId) => void window.xcoding.preview.destroy({ previewId }));
    }

    const saved = lastNonPreviewSelectionBySlotRef.current[slot];
    updateSlot(slot, (s) => {
      const panes: PaneId[] = ["A", "B", "C"];
      const findTab = (tabId: string) =>
        panes.find((pane) => s.panes[pane].tabs.some((t) => t.id === tabId)) ?? null;

      // In develop/other stages, do not show any preview tabs at all.
      let nextState: SlotUiState = s;
      for (const pane of panes) {
        const hasPreview = nextState.panes[pane].tabs.some((t) => t.type === "preview");
        if (!hasPreview) continue;
        const nextTabs = nextState.panes[pane].tabs.filter((t) => t.type !== "preview");
        const nextActive =
          nextTabs.some((t) => t.id === nextState.panes[pane].activeTabId) ? nextState.panes[pane].activeTabId : (nextTabs[0]?.id ?? "");
        nextState = {
          ...nextState,
          panes: { ...nextState.panes, [pane]: { tabs: nextTabs, activeTabId: nextActive } }
        };
      }

      if (saved) {
        const pane = findTab(saved.tabId);
        if (pane) {
          return {
            ...nextState,
            activePane: pane,
            panes: { ...nextState.panes, [pane]: { ...nextState.panes[pane], activeTabId: saved.tabId } }
          };
        }
        lastNonPreviewSelectionBySlotRef.current[slot] = null;
      }

      const firstNonPreview =
        panes
          .map((pane) => ({
            pane,
            tab: nextState.panes[pane].tabs.find((t) => t.type !== "preview") ?? null
          }))
          .find((x) => x.tab)?.tab ?? null;
      if (!firstNonPreview) return nextState;

      const pane = findTab(firstNonPreview.id);
      if (!pane) return nextState;
      return {
        ...nextState,
        activePane: pane,
        panes: { ...nextState.panes, [pane]: { ...nextState.panes[pane], activeTabId: firstNonPreview.id } }
      };
    });
  }

  function collapseEmptySplitPanes(state: SlotUiState): SlotUiState {
    if (state.layoutMode === "3x1") {
      const aHas = state.panes.A.tabs.length > 0;
      const bHas = state.panes.B.tabs.length > 0;
      const cHas = state.panes.C.tabs.length > 0;
      const alive = (["A", "B", "C"] as const).filter((p) => (p === "A" ? aHas : p === "B" ? bHas : cHas));
      if (alive.length === 3) return state;
      if (alive.length === 2) {
        const [first, second] = alive;
        const firstPane = state.panes[first];
        const secondPane = state.panes[second];
        const activePane = state.activePane === first ? "A" : state.activePane === second ? "B" : "A";
        return {
          ...state,
          layoutMode: "2x1",
          activePane,
          panes: {
            ...state.panes,
            A: { tabs: [...firstPane.tabs], activeTabId: firstPane.activeTabId },
            B: { tabs: [...secondPane.tabs], activeTabId: secondPane.activeTabId },
            C: { tabs: [], activeTabId: "" }
          }
        };
      }
      if (alive.length === 1) {
        const keep = alive[0] ?? "A";
        const kept = state.panes[keep];
        return {
          ...state,
          layoutMode: "1x1",
          activePane: "A",
          panes: {
            ...state.panes,
            A: { tabs: [...kept.tabs], activeTabId: kept.activeTabId },
            B: { tabs: [], activeTabId: "" },
            C: { tabs: [], activeTabId: "" }
          }
        };
      }
      return {
        ...state,
        layoutMode: "1x1",
        activePane: "A",
        panes: { ...state.panes, A: { tabs: [], activeTabId: "" }, B: { tabs: [], activeTabId: "" }, C: { tabs: [], activeTabId: "" } }
      };
    }
    if (state.layoutMode === "2x1") {
      const aHas = state.panes.A.tabs.length > 0;
      const bHas = state.panes.B.tabs.length > 0;
      if (aHas && bHas) return state;
      const keep = aHas ? ("A" as const) : bHas ? ("B" as const) : ("A" as const);
      const kept = state.panes[keep];
      return {
        ...state,
        layoutMode: "1x1",
        activePane: "A",
        panes: {
          ...state.panes,
          A: keep === "A" ? kept : { tabs: [...kept.tabs], activeTabId: kept.activeTabId },
          B: { tabs: [], activeTabId: "" }
        }
      };
    }
    if (state.layoutMode === "1x2") {
      const aHas = state.panes.A.tabs.length > 0;
      const cHas = state.panes.C.tabs.length > 0;
      if (aHas && cHas) return state;
      const keep = aHas ? ("A" as const) : cHas ? ("C" as const) : ("A" as const);
      const kept = state.panes[keep];
      return {
        ...state,
        layoutMode: "1x1",
        activePane: "A",
        panes: {
          ...state.panes,
          A: keep === "A" ? kept : { tabs: [...kept.tabs], activeTabId: kept.activeTabId },
          C: { tabs: [], activeTabId: "" }
        }
      };
    }
    return state;
  }

  function disposeSlotTerminals(state: SlotUiState) {
    const terminals = state.terminalPanel?.terminals ?? [];
    for (const t of terminals) {
      if (t.sessionId) void window.xcoding.terminal.dispose(t.sessionId);
    }
    const agentSessions = [state.agentCli?.claude?.sessionId, state.agentCli?.codex?.sessionId].filter(Boolean) as string[];
    for (const sessionId of agentSessions) {
      try {
        void window.xcoding.terminal.dispose(sessionId);
      } catch {
        // ignore
      }
    }
  }

  function resetSlotUi(slot: number) {
    setSlotUi((prev) => {
      const existing = prev[slot];
      if (existing) disposeSlotTerminals(existing);
      return { ...prev, [slot]: makeEmptySlotUiState() };
    });
  }

  const openPreviewIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ui of Object.values(slotUi)) {
      if (!ui) continue;
      (["A", "B", "C"] as const).forEach((pane) => {
        ui.panes[pane].tabs.forEach((tab) => {
          if (tab.type === "preview") ids.add(tab.id);
        });
      });
    }
    return Array.from(ids);
  }, [slotUi]);

  const activePaneState = activeUi.panes[activeUi.activePane];
  const activePaneTab = activePaneState.tabs.find((t) => t.id === activePaneState.activeTabId) ?? activePaneState.tabs[0] ?? null;
  const activePreviewTab = activePaneTab && activePaneTab.type === "preview" ? activePaneTab : null;
  const isPreviewFocus = Boolean(activePreviewTab && activeUi.previewUi?.mode === "preview");
  const effectiveLayout = {
    ...layout,
    isExplorerVisible: isWorkflowPreview || isPreviewFocus ? false : layout.isExplorerVisible,
    isChatVisible: isPreviewFocus ? false : layout.isChatVisible
  };

  function moveTabBetweenPanes(panes: SlotUiState["panes"], fromPane: PaneId, toPane: PaneId, tabId: string) {
    if (fromPane === toPane) return panes;
    const from = panes[fromPane];
    const to = panes[toPane];
    const tab = from.tabs.find((t) => t.id === tabId);
    if (!tab) return panes;
    if (to.tabs.some((t) => t.id === tabId)) return panes;
    const nextFromTabs = from.tabs.filter((t) => t.id !== tabId);
    const nextFromActive = from.activeTabId === tabId ? nextFromTabs[0]?.id ?? "" : from.activeTabId;
    return {
      ...panes,
      [fromPane]: { ...from, tabs: nextFromTabs, activeTabId: nextFromActive },
      [toPane]: { ...to, tabs: [...to.tabs, tab], activeTabId: tabId }
    };
  }

  function exitPreviewFocus(info: PreviewFocusInfo, options: { restoreSelection: boolean }) {
    previewFocusRef.current = null;
    updateSlot(info.slot, (s) => {
      const movedBack = info.previewSourcePane ? moveTabBetweenPanes(s.panes, "A", info.previewSourcePane, info.previewTabId) : s.panes;
      return collapseEmptySplitPanes({
        ...s,
        layoutMode: info.prevLayoutMode,
        layoutSplit: info.prevLayoutSplit,
        activePane: options.restoreSelection ? info.prevActivePane : s.activePane,
        panes: movedBack
      });
    });
  }

  useEffect(() => {
    const existing = previewFocusRef.current;
    if (existing && existing.slot !== activeProjectSlot) {
      exitPreviewFocus(existing, { restoreSelection: true });
    }

    const current = previewFocusRef.current;
    if (activePreviewTab) {
      if (current && current.slot === activeProjectSlot) return;
      const previewPane = activeUi.activePane;
      previewFocusRef.current = {
        slot: activeProjectSlot,
        previewTabId: activePreviewTab.id,
        prevLayoutMode: activeUi.layoutMode,
        prevLayoutSplit: activeUi.layoutSplit,
        prevActivePane: activeUi.activePane,
        previewSourcePane: previewPane === "A" ? null : previewPane
      };

      updateSlot(activeProjectSlot, (s) => {
        const activeId = activePreviewTab.id;
        const fromPane =
          (["A", "B", "C"] as const).find((p) => s.panes[p].tabs.some((t) => t.id === activeId)) ?? (previewPane as PaneId);
        const moved = fromPane === "A" ? { ...s.panes, A: { ...s.panes.A, activeTabId: activeId } } : moveTabBetweenPanes(s.panes, fromPane, "A", activeId);
        return {
          ...s,
          layoutMode: "1x1",
          activePane: "A",
          panes: moved
        };
      });
      return;
    }

    if (current && current.slot === activeProjectSlot) {
      exitPreviewFocus(current, { restoreSelection: false });
    }
  }, [activeProjectSlot, activePreviewTab?.id, activeUi.previewUi?.mode]);

  function persistLayout(next: typeof layout) {
    if (layoutPersistTimerRef.current != null) window.clearTimeout(layoutPersistTimerRef.current);
    const projectId = activeProjectId ?? null;
    layoutPersistTimerRef.current = window.setTimeout(() => {
      if (projectId) {
        void window.xcoding.projects.setUiLayout(projectId, {
          explorerWidth: next.explorerWidth,
          chatWidth: next.chatWidth,
          isExplorerVisible: next.isExplorerVisible,
          isChatVisible: next.isChatVisible
        });
      } else {
        void window.xcoding.settings.setLayout({
          explorerWidth: next.explorerWidth,
          chatWidth: next.chatWidth,
          isExplorerVisible: next.isExplorerVisible,
          isChatVisible: next.isChatVisible
        });
      }
    }, 200);
  }

  function setLayoutAndPersist(updater: (prev: typeof layout) => typeof layout) {
    setLayout((prev) => {
      const next = updater(prev);
      persistLayout(next);
      return next;
    });
  }

  function startResize(which: "explorer" | "chat", e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = layoutRef.current;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (which === "explorer") {
        const nextWidth = Math.max(180, Math.min(520, start.explorerWidth + dx));
        setLayout((prev) => ({ ...prev, explorerWidth: nextWidth }));
      } else {
        const nextWidth = Math.max(220, Math.min(640, start.chatWidth - dx));
        setLayout((prev) => ({ ...prev, chatWidth: nextWidth }));
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      persistLayout(layoutRef.current);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function openFolderIntoSlot(slot: number) {
    const normalizeProjectPath = (p: string) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const res = await window.xcoding.projects.openFolder(slot);
    if (!res.ok || res.canceled) return false;
    // Enforce VS Code behavior: a folder can only be open in one slot.
    try {
      const snap = await window.xcoding.projects.get();
      if (snap.ok) {
        const state = snap.state;
        const openedProjectId = String(res.projectId ?? "");
        const openedProjectPath = openedProjectId && state.projects?.[openedProjectId]?.path ? String(state.projects[openedProjectId].path) : "";
        const targetPathKey = openedProjectPath ? normalizeProjectPath(openedProjectPath) : "";
        const slotsWithSameProject = (state.slots ?? []).filter((s) => String(s.projectId ?? "") && String(s.projectId ?? "") === openedProjectId).map((s) => Number(s.slot));
        const slotsWithSamePath = targetPathKey
          ? (state.slots ?? [])
              .map((s) => ({ slot: Number(s.slot), projectId: String(s.projectId ?? "") }))
              .filter((s) => s.projectId && normalizeProjectPath(String(state.projects?.[s.projectId]?.path ?? "")) === targetPathKey)
              .map((s) => s.slot)
          : [];
        const dupSlots = Array.from(new Set([...slotsWithSameProject, ...slotsWithSamePath])).filter((n) => Number.isFinite(n));
        if (dupSlots.length > 1) {
          const keepSlot = dupSlots.slice().sort((a, b) => a - b)[0] ?? slot;
          if (keepSlot !== slot) {
            await window.xcoding.projects.unbindSlot(slot);
            setActiveProjectSlot(keepSlot);
            void window.xcoding.projects.setActiveSlot(keepSlot);
            return true;
          }
        }
      }
    } catch {
      // ignore
    }
    setActiveProjectSlot(slot);
    void window.xcoding.projects.setActiveSlot(slot);
    return true;
  }

  async function bindProjectIntoSlot(slot: number, projectPath: string) {
    const normalizeProjectPath = (p: string) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const desired = normalizeProjectPath(projectPath);
    if (desired) {
      const existingSlot = projectsState.slots
        .map((s) => ({ slot: s.slot, projectId: s.projectId }))
        .find((s) => {
          if (!s.projectId) return false;
          const p = projectsState.projects?.[s.projectId]?.path ?? "";
          return normalizeProjectPath(p) === desired;
        })?.slot;
      if (typeof existingSlot === "number" && existingSlot !== slot) {
        setActiveProjectSlot(existingSlot);
        void window.xcoding.projects.setActiveSlot(existingSlot);
        return true;
      }
    }
    const res = await window.xcoding.projects.setSlotPath(slot, projectPath);
    if (!res.ok) return false;
    setActiveProjectSlot(slot);
    void window.xcoding.projects.setActiveSlot(slot);
    return true;
  }

  function pickTargetSlot(preferred: number) {
    const isPreferredFree = !getSlotProjectId(projectsState, preferred);
    if (isPreferredFree) return preferred;
    const ordered =
      projectsState.slotOrder?.length === 8 ? projectsState.slotOrder : Array.from({ length: 8 }).map((_, i) => i + 1);
    const free = ordered.find((s) => !getSlotProjectId(projectsState, s));
    return free ?? preferred;
  }

  function openMarkdownPreview(relPath: string) {
    updateSlot(activeProjectSlot, (s) => {
      const normalizePane = (mode: LayoutMode, pane: PaneId): PaneId => {
        if (mode === "1x1") return "A";
        if (mode === "2x1") return pane === "C" ? "B" : pane;
        if (mode === "3x1") return pane;
        // 1x2
        return pane === "B" ? "A" : pane;
      };

      const currentMode = s.layoutMode;
      const editorPane = normalizePane(currentMode, s.activePane);

      let nextMode: LayoutMode = currentMode;
      let nextEditorPane: PaneId = editorPane;
      let previewPane: PaneId = "B";
      if (currentMode === "1x2") {
        nextMode = "2x1";
        nextEditorPane = "A";
      }
      if (nextMode === "1x1") {
        nextMode = "2x1";
        nextEditorPane = "A";
        previewPane = "B";
      } else if (nextMode === "2x1") {
        if (nextEditorPane === "A") {
          previewPane = "B";
        } else {
          nextMode = "3x1";
          previewPane = "C";
        }
      } else if (nextMode === "3x1") {
        previewPane = nextEditorPane === "A" ? "B" : nextEditorPane === "B" ? "C" : "B";
      }

      const suggestedCol2 = s.layoutSplit.col + (1 - s.layoutSplit.col) / 2;
      const nextSplit =
        nextMode === "3x1" && s.layoutMode !== "3x1"
          ? { ...s.layoutSplit, col2: Math.max(s.layoutSplit.col + 0.15, Math.min(0.85, suggestedCol2)) }
          : s.layoutSplit;

      const openPreviewTabInPane = (base: SlotUiState, pane: PaneId) => {
        const id = `tab-md-preview:${relPath}`;
        let existingPane: PaneId | null = null;
        let existingTab: AnyTab | null = null;
        for (const p of ["A", "B", "C"] as const) {
          const found = base.panes[p].tabs.find((t) => t.type === "markdown" && t.id === id) ?? null;
          if (found) {
            existingPane = p;
            existingTab = found;
            break;
          }
        }
        if (existingPane && existingTab) {
          if (existingPane === pane) {
            return { ...base, panes: { ...base.panes, [pane]: { ...base.panes[pane], activeTabId: existingTab.id } } };
          }
          const nextPanes: typeof base.panes = { ...base.panes };
          const fromTabs = nextPanes[existingPane].tabs.filter((t: AnyTab) => t.id !== id);
          const fromActive =
            nextPanes[existingPane].activeTabId === id ? (fromTabs[0]?.id ?? "") : nextPanes[existingPane].activeTabId;
          nextPanes[existingPane] = { tabs: fromTabs, activeTabId: fromActive };
          nextPanes[pane] = { tabs: [...nextPanes[pane].tabs, existingTab], activeTabId: id };
          return { ...base, panes: nextPanes };
        }
        const title = `${relPath.split("/").pop() ?? relPath} (Preview)`;
        const next: AnyTab = { id, type: "markdown", title, path: relPath };
        return { ...base, panes: { ...base.panes, [pane]: { tabs: [...base.panes[pane].tabs, next], activeTabId: id } } };
      };

      let next: SlotUiState = { ...s, layoutMode: nextMode, layoutSplit: nextSplit, activePane: nextEditorPane };
      next = openPreviewTabInPane(next, previewPane);
      return next;
    });
  }

  function openFile(relPath: string, line?: number, column?: number) {
    updateSlot(activeProjectSlot, (s) => {
      const pane = s.activePane;
      const existing = s.panes[pane].tabs.find((t) => t.type === "file" && "path" in t && t.path === relPath);
      const reveal = typeof line === "number" && line > 0 ? { line, column: typeof column === "number" && column > 0 ? column : 1, nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}` } : undefined;
      if (existing) {
        return {
          ...s,
          panes: {
            ...s.panes,
            [pane]: {
              tabs: s.panes[pane].tabs.map((t2) => (t2.id === existing.id && t2.type === "file" ? { ...t2, reveal } : t2)),
              activeTabId: existing.id
            }
          }
        };
      }
      const id = `tab-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const title = relPath.split("/").pop() ?? relPath;
      const next: AnyTab = { id, type: "file", title, path: relPath, dirty: false, reveal };
      return { ...s, panes: { ...s.panes, [pane]: { tabs: [...s.panes[pane].tabs, next], activeTabId: id } } };
    });
  }

  function openFileInSlot(slot: number, relPath: string, line?: number, column?: number) {
    updateSlot(slot, (s) => {
      const pane = s.activePane;
      const existing = s.panes[pane].tabs.find((t) => t.type === "file" && "path" in t && t.path === relPath);
      const reveal =
        typeof line === "number" && line > 0
          ? { line, column: typeof column === "number" && column > 0 ? column : 1, nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}` }
          : undefined;
      if (existing) {
        return {
          ...s,
          panes: {
            ...s.panes,
            [pane]: {
              tabs: s.panes[pane].tabs.map((t2) => (t2.id === existing.id && t2.type === "file" ? { ...t2, reveal } : t2)),
              activeTabId: existing.id
            }
          }
        };
      }
      const id = `tab-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const title = relPath.split("/").pop() ?? relPath;
      const next: AnyTab = { id, type: "file", title, path: relPath, dirty: false, reveal };
      return { ...s, panes: { ...s.panes, [pane]: { tabs: [...s.panes[pane].tabs, next], activeTabId: id } } };
    });
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { relPath?: string; line?: number; column?: number } | undefined;
      const relPath = String(detail?.relPath ?? "");
      if (!relPath) return;
      openFile(relPath, detail?.line, detail?.column);
    };
    window.addEventListener("xcoding:openFile", handler as any);
    return () => window.removeEventListener("xcoding:openFile", handler as any);
  }, [activeProjectSlot]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { title?: string; diff?: string; tabId?: string } | undefined;
      const diff = typeof detail?.diff === "string" ? detail.diff : "";
      if (!diff) return;
      const title = String(detail?.title ?? "Codex Diff");
      const stableId = typeof detail?.tabId === "string" && detail.tabId.trim() ? `tab-codex-diff:${detail.tabId.trim()}` : "";
      updateSlot(activeProjectSlot, (s) => {
        const pane = s.activePane;
        if (stableId) {
          // Reuse the same tab for the same logical diff (e.g. "Review") instead of opening unlimited tabs.
          for (const p of ["A", "B", "C"] as const) {
            const existing = s.panes[p].tabs.find((t) => t.type === "codexDiff" && t.id === stableId) ?? null;
            if (existing) {
              const nextPanes: typeof s.panes = { ...s.panes };
              // Update tab content in-place (copy-on-write for tabs array).
              nextPanes[p] = {
                ...nextPanes[p],
                tabs: nextPanes[p].tabs.map((t) => (t.type === "codexDiff" && t.id === stableId ? { ...t, title, diff } : t)),
                activeTabId: stableId
              };
              return { ...s, panes: nextPanes, activePane: p };
            }
          }
          const next: AnyTab = { id: stableId, type: "codexDiff", title, diff };
          return { ...s, panes: { ...s.panes, [pane]: { tabs: [...s.panes[pane].tabs, next], activeTabId: stableId } } };
        }

        const id = `tab-codex-diff-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const next: AnyTab = { id, type: "codexDiff", title, diff };
        return { ...s, panes: { ...s.panes, [pane]: { tabs: [...s.panes[pane].tabs, next], activeTabId: id } } };
      });
    };
    window.addEventListener("xcoding:openCodexDiff", handler as any);
    return () => window.removeEventListener("xcoding:openCodexDiff", handler as any);
  }, [activeProjectSlot]);

  function openNewPreview(url: string = "about:blank", title: string = "Preview") {
    if (activeProjectId) ensureProjectStage("preview");
    const id = `tab-preview-${Date.now()}`;
    const next: AnyTab = { id, type: "preview", title: title || "Preview", url };
    updateSlot(activeProjectSlot, (s) => ({
      ...s,
      panes: { ...s.panes, [s.activePane]: { tabs: [...s.panes[s.activePane].tabs, next], activeTabId: id } }
    }));
  }

  function openImageTab(absPathOrUrl: string, title?: string) {
    const url = String(absPathOrUrl ?? "");
    if (!url) return;
    if (activeProjectId) ensureProjectStage("develop");
    const id = `tab-image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const next: AnyTab = { id, type: "image", title: title || t("imagePreview"), url };
    updateSlot(activeProjectSlot, (s) => ({
      ...s,
      panes: { ...s.panes, [s.activePane]: { tabs: [...s.panes[s.activePane].tabs, next], activeTabId: id } }
    }));
  }

  function openAuxPreview(url: string, title: string) {
    const id = `tab-preview-${Date.now()}`;
    const next: AnyTab = { id, type: "preview", title: title || "Preview", url };
    updateSlot(activeProjectSlot, (s) => ({
      ...s,
      panes: { ...s.panes, [s.activePane]: { tabs: [...s.panes[s.activePane].tabs, next], activeTabId: id } }
    }));
  }

  function toggleOrCreateTerminalPanel(forceVisible?: boolean) {
    updateSlot(activeProjectSlot, (s) => {
      const panel = s.terminalPanel ?? { isVisible: false, height: 260, activeTab: "terminal", terminals: [], viewIds: [], focusedView: 0 };
      if (panel.terminals.length === 0) {
        const id = `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return {
          ...s,
          terminalPanel: {
            ...panel,
            isVisible: true,
            activeTab: "terminal",
            terminals: [{ id, title: "Terminal 1" }],
            viewIds: [id],
            focusedView: 0
          }
        };
      }
      const nextVisible = typeof forceVisible === "boolean" ? forceVisible : !panel.isVisible;
      const viewIds = panel.viewIds.length ? panel.viewIds : [panel.terminals[0]?.id ?? ""].filter(Boolean);
      const focusedView = Math.max(0, Math.min(viewIds.length - 1, panel.focusedView));
      return { ...s, terminalPanel: { ...panel, isVisible: nextVisible, activeTab: "terminal", viewIds, focusedView } };
    });
  }

  function showPanelTab(tab: TerminalPanelState["activeTab"]) {
    updateSlot(activeProjectSlot, (s) => {
      const panel = s.terminalPanel ?? { isVisible: false, height: 260, activeTab: "terminal", terminals: [], viewIds: [], focusedView: 0 };
      return { ...s, terminalPanel: { ...panel, isVisible: true, activeTab: tab } };
    });
  }

  function openDiff(path: string) {
    const ui = slotUiRef.current[activeProjectSlot] ?? makeEmptySlotUiState();
    const staged = ui.stagedContentByPath[path] ?? "";
    const p = ui.panes[ui.activePane];
    const existing = p.tabs.find((t) => t.type === "diff" && "path" in t && t.path === path);
    if (existing) {
      updateSlot(activeProjectSlot, (s) => ({ ...s, panes: { ...s.panes, [s.activePane]: { ...s.panes[s.activePane], activeTabId: existing.id } } }));
      return;
    }
    const id = `tab-diff-${Date.now()}`;
    const next: AnyTab = { id, type: "diff", title: "Diff", path, stagedContent: staged };
    updateSlot(activeProjectSlot, (s) => ({
      ...s,
      panes: { ...s.panes, [s.activePane]: { tabs: [...s.panes[s.activePane].tabs, next], activeTabId: id } }
    }));
  }

  function closeTab(pane: PaneId, tabId: string) {
    updateSlot(activeProjectSlot, (s) => {
      const nextTabs = s.panes[pane].tabs.filter((t) => t.id !== tabId);
      const nextActive = s.panes[pane].activeTabId === tabId ? nextTabs[0]?.id ?? "" : s.panes[pane].activeTabId;
      return collapseEmptySplitPanes({ ...s, panes: { ...s.panes, [pane]: { tabs: nextTabs, activeTabId: nextActive } } });
    });
  }

  async function sendChat() {
    const ui = slotUiRef.current[activeProjectSlot] ?? makeEmptySlotUiState();
    const input = ui.chatInput.trim();
    if (!input) return;
    const requestId = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    updateSlot(activeProjectSlot, (s) => ({
      ...s,
      chatInput: "",
      chatMessages: [...s.chatMessages, { role: "user" as const, content: input }],
      activeChatRequestId: requestId
    }));
    setAiBySlot((prev) => ({ ...prev, [activeProjectSlot]: "running" }));
    const messagesPayload = [
      ...ui.chatMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: input }
    ];
    await window.xcoding.ai.chatStart({ slot: activeProjectSlot, requestId, messages: messagesPayload });
  }

  async function stopChat() {
    const ui = slotUiRef.current[activeProjectSlot];
    if (!ui?.activeChatRequestId) return;
    await window.xcoding.ai.chatCancel({ slot: activeProjectSlot, requestId: ui.activeChatRequestId });
    updateSlot(activeProjectSlot, (s) => ({ ...s, activeChatRequestId: null }));
  }

  async function applyAll() {
    const res = await window.xcoding.ai.applyAll({ slot: activeProjectSlot });
    if (!res.ok) return;
    const staging = await window.xcoding.ai.getStaging({ slot: activeProjectSlot });
    if (!staging.ok) return;
    const files = Array.from(new Set(staging.staging.flatMap((p) => p.fileEdits.map((e) => e.path))));
    updateSlot(activeProjectSlot, (s) => ({ ...s, stagedFiles: files }));
  }

  async function revertLast() {
    await window.xcoding.ai.revertLast({ slot: activeProjectSlot });
    const res = await window.xcoding.ai.getStaging({ slot: activeProjectSlot });
    if (!res.ok) return;
    const files = Array.from(new Set(res.staging.flatMap((p) => p.fileEdits.map((e) => e.path))));
    updateSlot(activeProjectSlot, (s) => ({ ...s, stagedFiles: files }));
  }

  useEffect(() => {
    void window.xcoding.settings.get().then((s) => {
      setLanguage(s.ui.language);
      setAutoApplyAll(s.ai.autoApplyAll);
      setAiConfig({ apiBase: s.ai.apiBase, apiKey: s.ai.apiKey, model: s.ai.model });
      if (s.ui.layout) {
        defaultUiLayoutRef.current = s.ui.layout;
        setLayout(s.ui.layout);
      }
    });
    void window.xcoding.projects.get().then((res) => {
      if (!res.ok) return;
      setProjectsState(res.state as ProjectsState);
    });

    const disposeSwitch = window.xcoding.projects.onSwitchSlot(({ slot }) => {
      if (isSingleProjectWindow && slot !== lockedProjectSlotRef.current) return;
      setActiveProjectSlot(slot);
    });
    const disposeProjects = window.xcoding.projects.onState(({ state }) => {
      setProjectsState(state as ProjectsState);
    });
    void window.xcoding.window.getDetachedSlots().then((res) => {
      if (!res.ok) return;
      const slots = Array.isArray(res.slots) ? res.slots : [];
      setDetachedSlots(new Set(slots.filter((n) => typeof n === "number" && n >= 1 && n <= 8)));
    });
    const disposeDetached = window.xcoding.window.onDetachedSlots((payload) => {
      const slots = Array.isArray(payload.slots) ? payload.slots : [];
      setDetachedSlots(new Set(slots.filter((n) => typeof n === "number" && n >= 1 && n <= 8)));
    });
    const disposeAi = window.xcoding.ai.onStatus(({ slot, status }) => {
      setAiBySlot((prev) => ({ ...prev, [slot]: status === "error" ? "idle" : status }));
    });
    const disposeStream = window.xcoding.ai.onStream((evt) => {
      const slot = typeof evt.slot === "number" ? evt.slot : null;
      const targetSlot =
        slot ??
        (() => {
          for (let s = 1; s <= 8; s += 1) {
            const ui = slotUiRef.current[s];
            if (ui?.activeChatRequestId === evt.id) return s;
          }
          return null;
        })();
      if (!targetSlot) return;

      updateSlot(targetSlot, (prev) => {
        if (!prev.activeChatRequestId || prev.activeChatRequestId !== evt.id) return prev;

        if (evt.kind === "chunk" && evt.text) {
          const chunk = evt.text ?? "";
          const last = prev.chatMessages[prev.chatMessages.length - 1];
          const nextMessages =
            last?.role === "assistant"
              ? [...prev.chatMessages.slice(0, -1), { role: "assistant" as const, content: last.content + chunk }]
              : [...prev.chatMessages, { role: "assistant" as const, content: chunk }];
          return { ...prev, chatMessages: nextMessages };
        }

        if (evt.kind === "done") {
          window.setTimeout(() => setAiBySlot((s) => ({ ...s, [targetSlot]: "idle" })), 600);
          setAiBySlot((s) => ({ ...s, [targetSlot]: "done" }));
          return { ...prev, activeChatRequestId: null };
        }

        if (evt.kind === "error") {
          setAiBySlot((s) => ({ ...s, [targetSlot]: "idle" }));
          return { ...prev, activeChatRequestId: null };
        }

        return prev;
      });
    });

    return () => {
      disposeSwitch();
      disposeProjects();
      disposeDetached();
      disposeAi();
      disposeStream();
    };
  }, []);

  useEffect(() => {
    // Bootstrap main-side watchers/services for the initial slot of this window.
    void window.xcoding.projects.setActiveSlot(activeProjectSlot);
  }, []);

  useEffect(() => {
    const prev = prevSlotProjectIdRef.current;
    const next: Record<number, string | undefined> = {};
    for (let slot = 1; slot <= 8; slot += 1) next[slot] = getSlotProjectId(projectsState, slot);
    prevSlotProjectIdRef.current = next;

    const changedSlots: number[] = [];
    for (let slot = 1; slot <= 8; slot += 1) {
      if (prev[slot] !== next[slot]) changedSlots.push(slot);
    }
    if (changedSlots.length === 0) return;

    const loadSlotWorkflowStage = (slot: number, projectId?: string) => {
      if (!projectId) return null;
      try {
        const raw = localStorage.getItem(`xcoding.workflow.stage.${slot}.${projectId}`);
        if (raw === "preview" || raw === "develop") return raw as WorkflowStage;
      } catch {
        // ignore
      }
      return null;
    };

    setSlotUi((prevUi) => {
      let mutated = false;
      const nextUi: typeof prevUi = { ...prevUi };
      for (const slot of changedSlots) {
        const current = nextUi[slot];
        if (current) disposeSlotTerminals(current);
        const projectId = next[slot];
        const stage = loadSlotWorkflowStage(slot, projectId) ?? normalizeWorkflowStage(projectId ? projectsState.projects[projectId]?.workflow?.stage : "develop");
        nextUi[slot] = { ...makeEmptySlotUiState(), workflowUi: { stage } };
        mutated = true;
      }
      return mutated ? nextUi : prevUi;
    });
  }, [projectsState]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setLayoutAndPersist((p) => ({ ...p, isExplorerVisible: !p.isExplorerVisible }));
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  function onDragStartProject(e: DragEvent, slot: number) {
    draggingSlotRef.current = slot;
    lastProjectReorderAtRef.current = 0;
    e.dataTransfer.setData("application/x-xcoding-project-slot", JSON.stringify({ slot }));
    e.dataTransfer.effectAllowed = "move";
    const next = projectsState.slotOrder?.length === 8 ? [...projectsState.slotOrder] : Array.from({ length: 8 }).map((_, i) => i + 1);
    projectReorderStartOrderRef.current = next;
    projectReorderDidChangeRef.current = false;
    dragPreviewSlotOrderRef.current = next;
    setDragPreviewSlotOrder(next);
  }

  function onDragEndProject(e: DragEvent, slot: number) {
    draggingSlotRef.current = null;
    dragPreviewSlotOrderRef.current = null;
    setDragPreviewSlotOrder(null);

    // When dropped outside a valid drop target, treat it as "detach to new window".
    // This approximates the native VS Code behavior of dragging a workspace entry out.
    if (e.dataTransfer && e.dataTransfer.dropEffect === "none") {
      void window.xcoding.window.create({ slot, mode: "single" });
      setDetachedSlots((prev) => {
        const next = new Set(prev);
        next.add(slot);
        return next;
      });
      if (activeProjectSlot === slot) {
        const nextDetached = new Set(detachedSlots);
        nextDetached.add(slot);
        const fallback = baseProjectSlots.find((p) => p.slot !== slot && !nextDetached.has(p.slot))?.slot;
        if (fallback) {
          setActiveProjectSlot(fallback);
          void window.xcoding.projects.setActiveSlot(fallback);
        }
      }
    }
  }

  function onDragOverProject(e: DragEvent) {
    if (!e.dataTransfer.types.includes("application/x-xcoding-project-slot")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    const fromSlot = draggingSlotRef.current;
    const toSlot = Number((e.currentTarget as HTMLElement).getAttribute("data-slot") ?? "");
    if (!fromSlot || !toSlot || fromSlot === toSlot) return;
    const order = dragPreviewSlotOrder ?? projectsState.slotOrder;
    if (!order || order.length !== 8) return;
    const fromIdx = order.indexOf(fromSlot);
    const toIdx = order.indexOf(toSlot);
    if (fromIdx < 0 || toIdx < 0) return;

    // Avoid jitter: only reorder after crossing a threshold within the row (hysteresis),
    // and rate-limit reorders to avoid rapid oscillation when hovering near boundaries.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relY = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    const dir = Math.sign(toIdx - fromIdx); // +1 moving down, -1 moving up
    const threshold = dir > 0 ? 0.52 : dir < 0 ? 0.48 : 0.5;
    if ((dir > 0 && relY < threshold) || (dir < 0 && relY > threshold)) return;

    const now = Date.now();
    if (now - lastProjectReorderAtRef.current < 45) return;
    lastProjectReorderAtRef.current = now;
    const next = moveItem(order, fromIdx, toIdx);
    const start = projectReorderStartOrderRef.current;
    if (start && start.join(",") !== next.join(",")) projectReorderDidChangeRef.current = true;
    dragPreviewSlotOrderRef.current = next;
    setDragPreviewSlotOrder(next);
  }

  function onDropProject(e: DragEvent, slot: number) {
    const raw = e.dataTransfer.getData("application/x-xcoding-project-slot");
    if (!raw) return;
    e.preventDefault();
    let fromSlot: number | null = null;
    try {
      fromSlot = (JSON.parse(raw) as any)?.slot ?? null;
    } catch {
      fromSlot = draggingSlotRef.current;
    }
    draggingSlotRef.current = null;
    if (!fromSlot || fromSlot === slot) return;
    const currentOrder =
      projectsState.slotOrder?.length === 8 ? projectsState.slotOrder : Array.from({ length: 8 }).map((_, i) => i + 1);

    // When we do hover-based reordering (onDragOver), `dragPreviewSlotOrder` already represents the final order.
    // Applying `moveItem` again on drop would "undo" the last swap and cause a snap-back.
    const previewOrder = dragPreviewSlotOrderRef.current;
    const nextOrder = previewOrder && previewOrder.length === 8 ? previewOrder : (() => {
      const fromIdx = currentOrder.indexOf(fromSlot);
      const toIdx = currentOrder.indexOf(slot);
      if (fromIdx < 0 || toIdx < 0) return null;
      return moveItem(currentOrder, fromIdx, toIdx);
    })();

    setDragPreviewSlotOrder(null);
    dragPreviewSlotOrderRef.current = null;
    projectReorderStartOrderRef.current = null;
    projectReorderDidChangeRef.current = false;
    if (!nextOrder) return;

    if (currentOrder.join(",") !== nextOrder.join(",")) setProjectsState((s) => ({ ...s, slotOrder: nextOrder }));
    void window.xcoding.projects.reorderSlots(nextOrder).then((res) => {
      if (res.ok) return;
      setProjectsState((s) => ({ ...s, slotOrder: currentOrder }));
    });
  }

  async function closeProjectSlot(slot: number) {
    await window.xcoding.projects.unbindSlot(slot);
    resetSlotUi(slot);
  }

  function persistSlotWorkflowStage(slot: number, projectId: string, stage: WorkflowStage) {
    try {
      localStorage.setItem(`xcoding.workflow.stage.${slot}.${projectId}`, stage);
    } catch {
      // ignore
    }
  }

  async function setProjectViewMode(mode: "develop" | "preview") {
    if (!activeProjectId) return;
    const stage: WorkflowStage = mode === "preview" ? "preview" : "develop";
    persistSlotWorkflowStage(activeProjectSlot, activeProjectId, stage);
    appliedWorkflowStageBySlotRef.current[activeProjectSlot] = stage;
    updateSlot(activeProjectSlot, (s) => ({ ...s, workflowUi: { stage } }));
    applyWorkflowStageToSlot(activeProjectSlot, stage);
  }

  function ensureProjectStage(stage: WorkflowStage) {
    if (!activeProjectId) return false;
    if ((slotUiRef.current[activeProjectSlot]?.workflowUi?.stage ?? "develop") === stage) return true;
    persistSlotWorkflowStage(activeProjectSlot, activeProjectId, stage);
    appliedWorkflowStageBySlotRef.current[activeProjectSlot] = stage;
    updateSlot(activeProjectSlot, (s) => ({ ...s, workflowUi: { stage } }));
    applyWorkflowStageToSlot(activeProjectSlot, stage);
    return true;
  }

  async function openUrlFromTerminal(url: string) {
    if (!activeProjectId) {
      openNewPreview(url);
      return;
    }
    ensureProjectStage("preview");
    openNewPreview(url);
  }

  async function getBoundProjectIdFromMain(slot: number) {
    const res = await window.xcoding.projects.get();
    if (!res.ok) return null;
    return res.state.slots.find((s) => s.slot === slot)?.projectId ?? null;
  }

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      <div className="h-full w-full bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
        <TitleBar
          isExplorerVisible={effectiveLayout.isExplorerVisible}
          isChatVisible={effectiveLayout.isChatVisible}
          isTerminalVisible={Boolean(activeUi.terminalPanel?.isVisible && (activeUi.terminalPanel?.terminals?.length ?? 0) > 0)}
          onToggleExplorer={() => setLayoutAndPersist((p) => ({ ...p, isExplorerVisible: !p.isExplorerVisible }))}
          onToggleChat={() => setLayoutAndPersist((p) => ({ ...p, isChatVisible: !p.isChatVisible }))}
          onToggleTerminal={() => toggleOrCreateTerminalPanel()}
          centerTitle={activeProject?.name ?? ""}
          viewMode={activeViewMode ?? undefined}
          onViewModeChange={activeProjectId && activeViewMode ? ((mode) => void setProjectViewMode(mode)) : undefined}
          showExplorerToggle={!isWorkflowPreview}
          languageLabel={language === "en-US" ? t("languageChinese") : t("languageEnglish")}
          onToggleLanguage={() => void setLanguageAndPersist(language === "en-US" ? "zh-CN" : "en-US")}
        />

        <div className="flex h-[calc(100%-2.5rem)] min-h-0 w-full">
          {/* Idea/Auto stages: minimal workspace (doc/chat) */}
          {activeProjectId && (activeWorkflowStage === "idea" || activeWorkflowStage === "auto") ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-h-0 flex-1">
                {activeWorkflowStage === "idea" ? (
                  <div className="flex h-full w-full items-center justify-center p-10 text-sm text-[var(--vscode-descriptionForeground)]">
                    {t("ideaFlowInModalHint")}
                  </div>
                ) : (
                  <AutoWorkspace
                    slot={activeProjectSlot}
                    activeRelPath={activeUi.autoFollow.activeRelPath}
                    onTakeOver={() => void ensureProjectStage("develop")}
                    chat={
                      <ProjectChatPanel
                        slot={activeProjectSlot}
                        isVisible={true}
                        width={360}
                        onClose={() => {}}
                        projectRootPath={activeProjectPath}
                        terminalScrollback={terminalScrollback}
                        onOpenUrl={(url) => openNewPreview(url)}
                        onOpenImage={(url) => openImageTab(url)}
                        onOpenFile={(relPath, line, column) => openFile(relPath, line, column)}
                        allowedAgentViews={allowedAgentViews}
                        agentView={allowedAgentViews.includes(activeUi.agentView) ? activeUi.agentView : "codex"}
                        setAgentView={(next) => updateSlot(activeProjectSlot, (s) => ({ ...s, agentView: next }))}
                        agentCli={activeUi.agentCli}
                        updateAgentCli={(updater) => updateSlot(activeProjectSlot, (s) => ({ ...s, agentCli: updater(s.agentCli) }))}
                        aiConfig={aiConfig}
                        setAiConfig={setAiConfigAndPersist}
                        autoApplyAll={autoApplyAll}
                        setAutoApplyAll={setAutoApplyAllAndPersist}
                        chatInput={activeUi.chatInput}
                        setChatInput={(next) => updateSlot(activeProjectSlot, (s) => ({ ...s, chatInput: next }))}
                        chatMessages={activeUi.chatMessages}
                        activeRequestId={activeUi.activeChatRequestId}
                        onSend={() => void sendChat()}
                        onStop={() => void stopChat()}
                        stagedFiles={activeUi.stagedFiles}
                        onOpenDiff={(path) => openDiff(path)}
                        onApplyAll={() => void applyAll()}
                        onRevertLast={() => void revertLast()}
                      />
                    }
                  />
                )}
              </div>
            </div>
          ) : (
          <>
	          <ProjectSidebar
	            t={t}
	            isSingleProjectWindow={isSingleProjectWindow}
	            visualOrderedProjectSlots={visualOrderedProjectSlots}
	            visibleProjectSlotsForWindow={visibleProjectSlotsForWindow}
	            projectIndexBySlot={projectIndexBySlot}
		            projectRowRefs={projectRowRefs}
		            aiBySlot={aiBySlot}
		            activeProjectSlot={activeProjectSlot}
		            setActiveProjectSlot={(slot) => {
		              setActiveProjectSlot(slot);
		              void window.xcoding.projects.setActiveSlot(slot);
		            }}
		            onProjectContextMenuOpenNewWindow={(slot) => {
		              void window.xcoding.window.create({ slot, mode: "single" });
		              setDetachedSlots((prev) => {
		                const next = new Set(prev);
		                next.add(slot);
		                return next;
		              });
		              if (slot === activeProjectSlot) {
		                const remaining = visibleProjectSlotsForWindow.filter((x) => x.slot !== slot).map((x) => x.slot);
		                const nextActive = remaining[0];
		                if (typeof nextActive === "number") {
		                  setActiveProjectSlot(nextActive);
		                  void window.xcoding.projects.setActiveSlot(nextActive);
		                }
		              }
		            }}
		            onCloseProjectSlot={(slot) => void closeProjectSlot(slot)}
		            onOpenProjectPicker={() => setIsProjectPickerOpen(true)}
		            onDragStartProject={onDragStartProject}
	            onDragEndProject={onDragEndProject}
	            onDragOverProject={onDragOverProject}
	            onDropProject={onDropProject}
	          />

          {effectiveLayout.isExplorerVisible ? (
            <ExplorerPanel
              slot={activeProjectSlot}
              projectId={activeProjectId}
              rootPath={activeProjectPath}
              isBound={isActiveSlotBound}
              width={layout.explorerWidth}
              onOpenFolder={() => void openFolderIntoSlot(activeProjectSlot)}
              onOpenFile={openFile}
              onDeletedPaths={(paths) => {
                updateSlot(activeProjectSlot, (s) => {
                  const nextPanes: typeof s.panes = { ...s.panes };
                  (Object.keys(nextPanes) as Array<keyof typeof nextPanes>).forEach((pane) => {
                    const p = nextPanes[pane];
                    const filtered = p.tabs.filter((t2) => {
                      if (t2.type === "file" || t2.type === "diff") {
                        return !paths.some((deleted) => (deleted.endsWith("/") ? t2.path.startsWith(deleted) : t2.path === deleted));
                      }
                      return true;
                    });
                    const activeStillExists = filtered.some((t2) => t2.id === p.activeTabId);
                    nextPanes[pane] = { tabs: filtered, activeTabId: activeStillExists ? p.activeTabId : filtered[0]?.id ?? "" };
                  });
                  return { ...s, panes: nextPanes };
                });
              }}
            />
          ) : null}
          {effectiveLayout.isExplorerVisible ? (
            <div
              className="h-full w-1 cursor-col-resize bg-transparent hover:bg-[var(--vscode-panel-border)]"
              onMouseDown={(e) => startResize("explorer", e)}
              role="separator"
              aria-orientation="vertical"
            />
          ) : null}

	          <ProjectWorkspaceMain
	            t={t}
	            activeProjectSlot={activeProjectSlot}
	            activeProjectPath={activeProjectPath}
	            isActiveSlotBound={isActiveSlotBound}
	            recentProjects={recentProjects}
	            openFolderIntoSlot={openFolderIntoSlot}
	            bindProjectIntoSlot={bindProjectIntoSlot}
	            activeUi={activeUi}
	            setIsDraggingTab={setIsDraggingTab}
            updateSlot={updateSlot}
            closeTab={closeTab}
            collapseEmptySplitPanes={collapseEmptySplitPanes}
            openNewPreview={openNewPreview}
            openFile={openFile}
            openMarkdownPreview={openMarkdownPreview}
            toggleOrCreateTerminalPanel={toggleOrCreateTerminalPanel}
            showPanelTab={showPanelTab}
            openUrlFromTerminal={openUrlFromTerminal}
            terminalScrollback={terminalScrollback}
            openPreviewIds={openPreviewIds}
	            activePreviewTab={activePreviewTab}
	          />

	          {effectiveLayout.isChatVisible ? (
	            <div
	              className="group relative -ml-2 -mr-2 h-full w-4 shrink-0 cursor-col-resize bg-transparent"
	              onMouseDown={(e) => startResize("chat", e)}
	              role="separator"
	              aria-orientation="vertical"
	            >
	              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--vscode-panel-border)]" />
	            </div>
	          ) : null}
	
	          <div
	            className="relative h-full min-h-0 shrink-0"
	            style={effectiveLayout.isChatVisible ? ({ width: layout.chatWidth } as React.CSSProperties) : ({ width: 0 } as React.CSSProperties)}
	          >
	            {projectsState.slotOrder.map((slotNum) => {
	              const projectId = getSlotProjectId(projectsState, slotNum);
	              const projectPath = projectId ? projectsState.projects[projectId]?.path : undefined;
	              const ui = slotUi[slotNum] ?? makeEmptySlotUiState();
	              const isVisible = effectiveLayout.isChatVisible && slotNum === activeProjectSlot;
	              return (
	                <div
	                  key={slotNum}
	                  className={[
	                    "absolute inset-0",
	                    isVisible ? "" : "pointer-events-none"
	                  ].join(" ")}
	                >
	                  <ProjectChatPanel
	                    slot={slotNum}
	                    isVisible={isVisible}
	                    onClose={() => setLayoutAndPersist((p) => ({ ...p, isChatVisible: false }))}
	                    projectRootPath={projectPath}
	                    terminalScrollback={terminalScrollback}
	                    onOpenUrl={(url) => openNewPreview(url)}
	                    onOpenImage={(url) => openImageTab(url)}
	                    onOpenFile={(relPath, line, column) => openFileInSlot(slotNum, relPath, line, column)}
	                    allowedAgentViews={allowedAgentViews}
	                    agentView={ui.agentView}
	                    setAgentView={(next) => updateSlot(slotNum, (s) => ({ ...s, agentView: next }))}
	                    agentCli={ui.agentCli}
	                    updateAgentCli={(updater) => updateSlot(slotNum, (s) => ({ ...s, agentCli: updater(s.agentCli) }))}
	                    aiConfig={aiConfig}
	                    setAiConfig={setAiConfigAndPersist}
	                    autoApplyAll={autoApplyAll}
	                    setAutoApplyAll={setAutoApplyAllAndPersist}
	                    chatInput={ui.chatInput}
	                    setChatInput={(next) => updateSlot(slotNum, (s) => ({ ...s, chatInput: next }))}
	                    chatMessages={ui.chatMessages}
	                    activeRequestId={ui.activeChatRequestId}
	                    onSend={() => void sendChat()}
	                    onStop={() => void stopChat()}
	                    stagedFiles={ui.stagedFiles}
	                    onOpenDiff={(path) => openDiff(path)}
	                    onApplyAll={() => void applyAll()}
	                    onRevertLast={() => void revertLast()}
	                  />
	                </div>
	              );
	            })}
	          </div>

          <NewProjectWizardModal
            isOpen={isProjectPickerOpen}
            projects={recentProjects}
            onClose={() => setIsProjectPickerOpen(false)}
            onOpenExisting={() => {
              const target = pickTargetSlot(activeProjectSlot);
              void openFolderIntoSlot(target).then(() => setIsProjectPickerOpen(false));
            }}
            onPickRecent={(p) => {
              const target = pickTargetSlot(activeProjectSlot);
              void bindProjectIntoSlot(target, p.path).then(async (ok) => {
                if (!ok) return;
                // Existing projects default to develop.
                const projectId = (await getBoundProjectIdFromMain(target)) ?? getSlotProjectId(projectsState, target) ?? null;
                if (projectId) await window.xcoding.projects.setWorkflow(projectId, { stage: "develop" });
                setIsProjectPickerOpen(false);
              });
            }}
          />
          </>
          )}
        </div>

	        <IdeaFlowModal
	          isOpen={Boolean(!isProjectPickerOpen && activeProjectId && activeWorkflowStage === "idea")}
	          projectName={activeProject?.name ?? ""}
	          slot={activeProjectSlot}
	          projectRootPath={activeProjectPath}
	          docPath=".xcoding/idea.md"
	          filesWritten={activeUi.ideaFlow?.writtenFiles ?? []}
	          onClose={() => void ensureProjectStage("develop")}
	          onStartAuto={() => void ensureProjectStage("auto")}
	          onSkip={() => void ensureProjectStage("develop")}
	          onOpenUrl={(url) => openNewPreview(url)}
	          onOpenFile={(p) => openFile(p)}
	          chat={
	            <ProjectChatPanel
	              slot={activeProjectSlot}
	              isVisible={true}
	              width={undefined}
	              onClose={() => void ensureProjectStage("develop")}
	              projectRootPath={activeProjectPath}
	              terminalScrollback={terminalScrollback}
	              onOpenUrl={(url) => openNewPreview(url)}
	              onOpenImage={(url) => openImageTab(url)}
	              onOpenFile={(relPath, line, column) => openFile(relPath, line, column)}
	              allowedAgentViews={allowedAgentViews}
	              agentView={activeUi.agentView}
	              setAgentView={(next) => updateSlot(activeProjectSlot, (s) => ({ ...s, agentView: next }))}
	              agentCli={activeUi.agentCli}
	              updateAgentCli={(updater) => updateSlot(activeProjectSlot, (s) => ({ ...s, agentCli: updater(s.agentCli) }))}
	              aiConfig={aiConfig}
	              setAiConfig={setAiConfigAndPersist}
	              autoApplyAll={autoApplyAll}
	              setAutoApplyAll={setAutoApplyAllAndPersist}
	              chatInput={activeUi.chatInput}
	              setChatInput={(next) => updateSlot(activeProjectSlot, (s) => ({ ...s, chatInput: next }))}
	              chatMessages={activeUi.chatMessages}
	              activeRequestId={activeUi.activeChatRequestId}
	              onSend={() => void sendChat()}
	              onStop={() => void stopChat()}
	              stagedFiles={activeUi.stagedFiles}
	              onOpenDiff={(path) => openDiff(path)}
	              onApplyAll={() => void applyAll()}
	              onRevertLast={() => void revertLast()}
	            />
	          }
	        />
      </div>
    </I18nContext.Provider>
  );
}
