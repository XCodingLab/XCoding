import type { LayoutMode, PaneId } from "./LayoutManager";
import type { TerminalPanelState } from "./TerminalPanel";

export type AiStatus = "idle" | "running" | "done";

export type WorkspaceTab =
  | { id: string; type: "file"; title: string; path: string; dirty?: boolean; reveal?: { line: number; column: number; nonce: string } }
  | { id: string; type: "preview"; title: string; url: string }
  | { id: string; type: "image"; title: string; url: string }
  | { id: string; type: "markdown"; title: string; path: string }
  | { id: string; type: "codexDiff"; title: string; diff: string };

export type DiffTab = { id: string; type: "diff"; title: string; path: string; stagedContent: string };

export type AnyTab = WorkspaceTab | DiffTab;

export type SlotUiState = {
  layoutMode: LayoutMode;
  layoutSplit: { col: number; col2: number; row: number };
  activePane: PaneId;
  panes: Record<PaneId, { tabs: AnyTab[]; activeTabId: string }>;
  terminalPanel: TerminalPanelState;
  previewUi: { mode: "standard" | "preview" };
  workflowUi: { stage: WorkflowStage };

  agentView: "chat" | "claude" | "codex";
  agentCli: {
    claude: { tabId: string; sessionId?: string; hasStarted: boolean };
    codex: { tabId: string; sessionId?: string; hasStarted: boolean };
  };

  chatInput: string;
  chatMessages: Array<{ role: "user" | "assistant"; content: string }>;
  activeChatRequestId: string | null;

  stagedFiles: string[];
  stagedContentByPath: Record<string, string>;

  autoFollow: { activeRelPath: string };
  ideaFlow: { writtenFiles: string[] };
};

export type ProjectsState = {
  schemaVersion: 3;
  slotOrder: number[];
  slots: Array<{ slot: number; projectId?: string }>;
  projects: Record<
    string,
    {
      id: string;
      path: string;
      name: string;
      lastOpenedAt: number;
      uiLayout?: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean };
      workflow?: { stage: "idea" | "auto" | "preview" | "develop"; lastUpdatedAt?: number };
    }
  >;
};

export type PreviewFocusInfo = {
  slot: number;
  previewTabId: string;
  previewSourcePane: PaneId | null;
  prevLayoutMode: LayoutMode;
  prevLayoutSplit: SlotUiState["layoutSplit"];
  prevActivePane: PaneId;
};

export type WorkflowStage = "idea" | "auto" | "preview" | "develop";

export function normalizeWorkflowStage(raw: unknown): WorkflowStage {
  // 隐藏 idea/auto 阶段：UI 侧一律按 develop 处理（仅保留 develop/preview）。
  if (raw === "preview" || raw === "develop") return raw;
  return "develop";
}

export function makeEmptySlotUiState(): SlotUiState {
  return {
    layoutMode: "1x1",
    layoutSplit: { col: 0.5, col2: 0.75, row: 0.5 },
    activePane: "A",
    panes: {
      A: { tabs: [], activeTabId: "" },
      B: { tabs: [], activeTabId: "" },
      C: { tabs: [], activeTabId: "" }
    },
    terminalPanel: { isVisible: false, height: 260, activeTab: "terminal", terminals: [], viewIds: [], focusedView: 0 },
    previewUi: { mode: "standard" },
    workflowUi: { stage: "develop" },
    agentView: "codex",
    agentCli: {
      claude: { tabId: "agent-claude", hasStarted: false },
      codex: { tabId: "agent-codex", hasStarted: false }
    },
    chatInput: "",
    chatMessages: [],
    activeChatRequestId: null,
    stagedFiles: [],
    stagedContentByPath: {},
    autoFollow: { activeRelPath: "" },
    ideaFlow: { writtenFiles: [] }
  };
}

export function workflowAllowsExternalAgents(stage: WorkflowStage) {
  // User confirmed: idea/auto must use built-in chat only; preview/develop can use external agents.
  return stage === "preview" || stage === "develop";
}

export function getSlotProjectId(state: ProjectsState, slot: number) {
  return state.slots.find((s) => s.slot === slot)?.projectId;
}
