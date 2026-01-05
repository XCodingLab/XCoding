import { Bug, Network, Eye } from "lucide-react";
import DiffView from "./DiffView";
import CodexDiffView from "./CodexDiffView";
import FileEditor from "./FileEditor";
import LayoutManager, { type LayoutMode, type PaneId, type SplitIntent } from "./LayoutManager";
import MarkdownPreviewView from "./MarkdownPreviewView";
import ImagePreviewView from "./ImagePreviewView";
import PreviewView from "./PreviewView";
import TerminalPanel, { type TerminalPanelState } from "./TerminalPanel";
import WelcomeView from "./WelcomeView";
import type { AnyTab, SlotUiState } from "./appTypes";

function isMarkdownFilePath(relPath: string) {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

type Props = {
  t: (key: any) => string;
  activeProjectSlot: number;
  activeProjectPath?: string;
  isActiveSlotBound: boolean;
  recentProjects: Array<{ id: string; name: string; path: string; lastOpenedAt: number }>;
  openFolderIntoSlot: (slot: number) => Promise<unknown>;
  bindProjectIntoSlot: (slot: number, path: string) => Promise<boolean>;

  activeUi: SlotUiState;
  setIsDraggingTab: (next: boolean) => void;
  updateSlot: (slot: number, updater: (prev: SlotUiState) => SlotUiState) => void;
  closeTab: (pane: PaneId, tabId: string) => void;
  collapseEmptySplitPanes: (state: SlotUiState) => SlotUiState;

  openNewPreview: (url?: string) => void;
  openFile: (relPath: string, line?: number, column?: number) => void;
  openMarkdownPreview: (relPath: string) => void;
  toggleOrCreateTerminalPanel: (focus?: boolean) => void;
  showPanelTab: (tab: TerminalPanelState["activeTab"]) => void;
  openUrlFromTerminal: (url: string) => Promise<void>;

  terminalScrollback: number;
  openPreviewIds: string[];
  activePreviewTab: { id: string; url: string } | null;
};

export default function ProjectWorkspaceMain(props: Props) {
  const {
    t,
    activeProjectSlot,
    activeProjectPath,
    isActiveSlotBound,
    recentProjects,
    openFolderIntoSlot,
    bindProjectIntoSlot,
    activeUi,
    setIsDraggingTab,
    updateSlot,
    closeTab,
    collapseEmptySplitPanes,
    openNewPreview,
    openFile,
    openMarkdownPreview,
    toggleOrCreateTerminalPanel,
    showPanelTab,
    openUrlFromTerminal,
    terminalScrollback,
    openPreviewIds,
    activePreviewTab
  } = props;

  return (
    <main className="min-w-0 flex-1 bg-[var(--vscode-editor-background)]">
      {!isActiveSlotBound ? (
        <WelcomeView
          recentProjects={recentProjects}
          onOpenFolder={() => void openFolderIntoSlot(activeProjectSlot)}
          onOpenRecent={(p) => void bindProjectIntoSlot(activeProjectSlot, p.path)}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 p-3">
            <LayoutManager
              mode={activeUi.layoutMode}
              split={activeUi.layoutSplit}
              activePane={activeUi.activePane}
              panes={activeUi.panes}
              onTabDragStateChange={setIsDraggingTab}
              setSplit={(next) => updateSlot(activeProjectSlot, (s) => ({ ...s, layoutSplit: next }))}
              setActivePane={(pane) => updateSlot(activeProjectSlot, (s) => ({ ...s, activePane: pane }))}
              onActivateTab={(pane, tabId) => {
                updateSlot(activeProjectSlot, (s) => ({
                  ...s,
                  activePane: pane,
                  panes: { ...s.panes, [pane]: { ...s.panes[pane], activeTabId: tabId } }
                }));
              }}
              onCloseTab={(pane, tabId) => closeTab(pane, tabId)}
              onMoveTab={(fromPane, toPane, tabId, intent) => {
                updateSlot(activeProjectSlot, (s) => {
                  const applyIntentMode = (prev: SlotUiState, intent: SplitIntent): SlotUiState => {
                    if (intent.mode === prev.layoutMode) return prev;
                    if (intent.mode === "3x1") {
                      const col = prev.layoutSplit.col;
                      const suggested = col + (1 - col) / 2;
                      const col2 = Math.max(col + 0.15, Math.min(0.85, prev.layoutSplit.col2 || suggested || 0.75));
                      return { ...prev, layoutMode: "3x1", layoutSplit: { ...prev.layoutSplit, col2 } };
                    }
                    return { ...prev, layoutMode: intent.mode as LayoutMode };
                  };

                  const from = s.panes[fromPane];
                  const to = s.panes[toPane];
                  const moving = from.tabs.find((t2) => t2.id === tabId);
                  if (!moving) return s;
                  if (!intent && fromPane === toPane) return s;

                  if (intent && s.layoutMode === "1x1" && intent.mode === "2x1") {
                    // VS Code-like: dropping to left creates a new left group, keeping the rest on the right.
                    const all = s.panes.A.tabs;
                    const rest = all.filter((t2) => t2.id !== tabId);
                    if (toPane === "A") {
                      const nextState: SlotUiState = applyIntentMode(
                        {
                          ...s,
                          activePane: "A",
                          panes: {
                            ...s.panes,
                            A: { tabs: [moving], activeTabId: tabId },
                            B: { tabs: rest, activeTabId: rest[0]?.id ?? "" }
                          }
                        },
                        intent
                      );
                      return collapseEmptySplitPanes(nextState);
                    }
                    const nextState: SlotUiState = applyIntentMode(
                      {
                        ...s,
                        activePane: "B",
                        panes: {
                          ...s.panes,
                          A: { tabs: rest, activeTabId: rest[0]?.id ?? "" },
                          B: { tabs: [moving], activeTabId: tabId }
                        }
                      },
                      intent
                    );
                    return collapseEmptySplitPanes(nextState);
                  }

                  if (intent && s.layoutMode === "1x1" && intent.mode === "1x2") {
                    const all = s.panes.A.tabs;
                    const rest = all.filter((t2) => t2.id !== tabId);
                    if (toPane === "A") {
                      const nextState: SlotUiState = applyIntentMode(
                        {
                          ...s,
                          activePane: "A",
                          panes: {
                            ...s.panes,
                            A: { tabs: [moving], activeTabId: tabId },
                            C: { tabs: rest, activeTabId: rest[0]?.id ?? "" }
                          }
                        },
                        intent
                      );
                      return collapseEmptySplitPanes(nextState);
                    }
                    const nextState: SlotUiState = applyIntentMode(
                      {
                        ...s,
                        activePane: "C",
                        panes: {
                          ...s.panes,
                          A: { tabs: rest, activeTabId: rest[0]?.id ?? "" },
                          C: { tabs: [moving], activeTabId: tabId }
                        }
                      },
                      intent
                    );
                    return collapseEmptySplitPanes(nextState);
                  }

                  const s2 = intent ? applyIntentMode(s, intent) : s;
                  const nextFromTabs = s2.panes[fromPane].tabs.filter((t2) => t2.id !== tabId);
                  const nextToTabs = [...s2.panes[toPane].tabs, moving];
                  const nextState: SlotUiState = {
                    ...s2,
                    activePane: toPane,
                    panes: {
                      ...s2.panes,
                      [fromPane]: { tabs: nextFromTabs, activeTabId: nextFromTabs[0]?.id ?? "" },
                      [toPane]: { tabs: nextToTabs, activeTabId: tabId }
                    }
                  };
                  return collapseEmptySplitPanes(nextState);
                });
              }}
              onDropFile={(toPane, relPath, intent) => {
                updateSlot(activeProjectSlot, (s) => {
                  const openIntoPane = (base: SlotUiState, pane: PaneId) => {
                    const existing = base.panes[pane].tabs.find((t2) => t2.type === "file" && "path" in t2 && t2.path === relPath);
                    if (existing) {
                      return { ...base, activePane: pane, panes: { ...base.panes, [pane]: { ...base.panes[pane], activeTabId: existing.id } } };
                    }
                    const id = `tab-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                    const title = relPath.split("/").pop() ?? relPath;
                    const next: AnyTab = { id, type: "file", title, path: relPath, dirty: false };
                    return { ...base, activePane: pane, panes: { ...base.panes, [pane]: { tabs: [...base.panes[pane].tabs, next], activeTabId: id } } };
                  };

                  const applyIntentMode = (prev: SlotUiState, intent: SplitIntent): SlotUiState => {
                    if (intent.mode === prev.layoutMode) return prev;
                    if (intent.mode === "3x1") {
                      const col = prev.layoutSplit.col;
                      const suggested = col + (1 - col) / 2;
                      const col2 = Math.max(col + 0.15, Math.min(0.85, prev.layoutSplit.col2 || suggested || 0.75));
                      return { ...prev, layoutMode: "3x1", layoutSplit: { ...prev.layoutSplit, col2 } };
                    }
                    return { ...prev, layoutMode: intent.mode as LayoutMode };
                  };

                  if (intent && s.layoutMode === "1x1" && intent.mode === "2x1") {
                    if (toPane === "A") {
                      const shifted: SlotUiState = applyIntentMode(
                        { ...s, panes: { ...s.panes, B: { ...s.panes.A }, A: { tabs: [], activeTabId: "" } }, activePane: "A" },
                        intent
                      );
                      return collapseEmptySplitPanes(openIntoPane(shifted, "A"));
                    }
                    const nextState: SlotUiState = applyIntentMode(s, intent);
                    return collapseEmptySplitPanes(openIntoPane(nextState, "B"));
                  }

                  if (intent && s.layoutMode === "1x1" && intent.mode === "1x2") {
                    if (toPane === "A") {
                      const shifted: SlotUiState = applyIntentMode(
                        { ...s, panes: { ...s.panes, C: { ...s.panes.A }, A: { tabs: [], activeTabId: "" } }, activePane: "A" },
                        intent
                      );
                      return collapseEmptySplitPanes(openIntoPane(shifted, "A"));
                    }
                    const nextState: SlotUiState = applyIntentMode(s, intent);
                    return collapseEmptySplitPanes(openIntoPane(nextState, "C"));
                  }

                  const nextState: SlotUiState = intent ? applyIntentMode(s, intent) : s;
                  return collapseEmptySplitPanes(openIntoPane(nextState, toPane));
                });
              }}
              renderTabLabel={(tab) => ("dirty" in tab && tab.dirty ? `${tab.title} *` : tab.title)}
              renderTab={(pane, tab) => {
                const isTabActive = tab.id === activeUi.panes[pane].activeTabId;
                if (tab.type === "markdown") {
                  return (
                    <MarkdownPreviewView
                      slot={activeProjectSlot}
                      path={tab.path}
                      projectRootPath={activeProjectPath}
                      onOpenUrl={(url) => openNewPreview(url)}
                      onOpenFile={(rel) => openFile(rel)}
                      onPreviewOnly={() => {
                        updateSlot(activeProjectSlot, (s) => {
                          const nextPanes: typeof s.panes = { ...s.panes };
                          (Object.keys(nextPanes) as Array<keyof typeof nextPanes>).forEach((p) => {
                            const prev = nextPanes[p];
                            const filtered = prev.tabs.filter((t2) => !(t2.type === "file" && "path" in t2 && t2.path === tab.path));
                            const activeStillExists = filtered.some((t2) => t2.id === prev.activeTabId);
                            nextPanes[p] = { tabs: filtered, activeTabId: activeStillExists ? prev.activeTabId : filtered[0]?.id ?? "" };
                          });
                          return collapseEmptySplitPanes({ ...s, activePane: pane, panes: nextPanes });
                        });
                      }}
                      onShowEditor={() => {
                        updateSlot(activeProjectSlot, (s) => {
                          const ensureMode = (m: LayoutMode) => (m === "1x1" || m === "1x2" ? ("2x1" as const) : m);
                          const mode = ensureMode(s.layoutMode);
                          const editorPane: PaneId = pane === "B" ? "A" : pane === "C" ? "B" : "B";
                          const openInto = (base: SlotUiState, target: PaneId) => {
                            const existing = base.panes[target].tabs.find((t2) => t2.type === "file" && "path" in t2 && t2.path === tab.path);
                            if (existing) {
                              return { ...base, activePane: target, panes: { ...base.panes, [target]: { ...base.panes[target], activeTabId: existing.id } } };
                            }
                            const id = `tab-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                            const title = tab.path.split("/").pop() ?? tab.path;
                            const next: AnyTab = { id, type: "file", title, path: tab.path, dirty: false };
                            return { ...base, activePane: target, panes: { ...base.panes, [target]: { tabs: [...base.panes[target].tabs, next], activeTabId: id } } };
                          };
                          return openInto({ ...s, layoutMode: mode }, editorPane);
                        });
                      }}
                    />
                  );
                }
                if (tab.type === "preview") {
                  const mode = activeUi.previewUi?.mode ?? "standard";
                  return (
                    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-[var(--vscode-panel-border)]">
                      <div className="flex items-center gap-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2">
                        <input
                          className="min-w-0 flex-1 rounded bg-[var(--vscode-input-background)] px-2 py-1 text-xs text-[var(--vscode-input-foreground)] outline-none ring-1 ring-[var(--vscode-input-border)] focus:ring-[var(--vscode-focusBorder)]"
                          value={tab.url}
                          onChange={(e) => {
                            const nextUrl = e.target.value;
                            updateSlot(activeProjectSlot, (s) => ({
                              ...s,
                              panes: {
                                ...s.panes,
                                [pane]: {
                                  ...s.panes[pane],
                                  tabs: s.panes[pane].tabs.map((t2) => (t2.id === tab.id && t2.type === "preview" ? { ...t2, url: nextUrl } : t2))
                                }
                              }
                            }));
                          }}
                        />
                        <button
                          className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-xs text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                          onClick={() => void window.xcoding.preview.navigate({ previewId: tab.id, url: tab.url })}
                          type="button"
                        >
                          Go
                        </button>
                        <button
                          className={[
                            "rounded px-2 py-1 text-[11px]",
                            mode === "preview"
                              ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
                              : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]"
                          ].join(" ")}
                          onClick={() => {
                            updateSlot(activeProjectSlot, (s) => ({
                              ...s,
                              previewUi: { mode: (s.previewUi?.mode ?? "standard") === "preview" ? "standard" : "preview" }
                            }));
                          }}
                          type="button"
                          title={mode === "preview" ? t("previewModeFocused") : t("standardModeShowCode")}
                        >
                          {mode === "preview" ? t("preview") : t("standard")}
                        </button>
                        <button
                          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                          onClick={() => showPanelTab("previewConsole")}
                          type="button"
                          title={t("console")}
                        >
                          <Bug className="h-4 w-4" />
                        </button>
                        <button
                          className="rounded p-1 text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                          onClick={() => showPanelTab("previewNetwork")}
                          type="button"
                          title={t("network")}
                        >
                          <Network className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 p-2">
                        <PreviewView isActive={isTabActive} previewId={tab.id} url={tab.url} />
                      </div>
                    </div>
                  );
                }
                if (tab.type === "image") return <ImagePreviewView url={tab.url} title={tab.title} />;
                if (tab.type === "diff") return <DiffView slot={activeProjectSlot} path={tab.path} stagedContent={tab.stagedContent} />;
                if (tab.type === "codexDiff") return <CodexDiffView diff={tab.diff} />;
                if (tab.type === "file") {
                  const rightExtras =
                    isMarkdownFilePath(tab.path) && activeProjectPath
                      ? (
                        <button
                          className="flex items-center gap-1 rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-0.5 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                          type="button"
                          onClick={() => openMarkdownPreview(tab.path)}
                          title={t("openPreview")}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        )
                      : null;

                  return (
                    <FileEditor
                      slot={activeProjectSlot}
                      path={tab.path}
                      reveal={tab.reveal}
                      rightExtras={rightExtras}
                      onDirtyChange={(dirty) => {
                        updateSlot(activeProjectSlot, (s) => ({
                          ...s,
                          panes: {
                            ...s.panes,
                            [pane]: {
                              ...s.panes[pane],
                              tabs: s.panes[pane].tabs.map((t2) => (t2.id === tab.id && t2.type === "file" ? { ...t2, dirty } : t2))
                            }
                          }
                        }));
                      }}
                    />
                  );
                }
                return <div className="flex h-full items-center justify-center text-sm text-[var(--vscode-descriptionForeground)]">{t("editorPlaceholder")}</div>;
              }}
              renderEmpty={() => (
                <div className="max-w-[520px]">
                  <div className="mb-1 text-base font-semibold text-[var(--vscode-foreground)]">{t("workspaceEmptyTitle")}</div>
                  <div className="text-sm text-[var(--vscode-descriptionForeground)]">{t("workspaceEmptyHint")}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="rounded bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-sm text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                      onClick={() => toggleOrCreateTerminalPanel(true)}
                      type="button"
                    >
                      {t("newTerminal")}
                    </button>
                    <button
                      className="rounded bg-[var(--vscode-button-secondaryBackground)] px-3 py-1.5 text-sm text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
                      onClick={() => openNewPreview()}
                      type="button"
                    >
                      {t("newPreview")}
                    </button>
                  </div>
                </div>
              )}
            />
          </div>

          <TerminalPanel
            slot={activeProjectSlot}
            projectRootPath={activeProjectPath}
            scrollback={terminalScrollback}
            state={activeUi.terminalPanel}
            openPreviewIds={openPreviewIds}
            activePreviewId={activePreviewTab?.id ?? null}
            activePreviewUrl={activePreviewTab?.url ?? null}
            onUpdate={(updater) => updateSlot(activeProjectSlot, (s) => ({ ...s, terminalPanel: updater(s.terminalPanel) }))}
            onOpenUrl={(url) => void openUrlFromTerminal(url)}
            onOpenFile={(relPath, line, column) => openFile(relPath, line, column)}
          />
        </div>
      )}
    </main>
  );
}
