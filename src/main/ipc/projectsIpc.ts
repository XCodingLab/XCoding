import { dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { activeSlotByWindowId, broadcast, getWindowFromEvent, mainWindow } from "../app/windowManager";
import { broadcastAiStatus, clearSlotStaging } from "../managers/aiManager";
import { ensureProjectService, scheduleFreeze, sendToProjectService } from "../managers/projectServiceManager";
import { persistProjectsToDisk, projectsState, type ProjectWorkflow, type WorkflowStage } from "../stores/projectsStore";
import type { UiLayout } from "../stores/settingsStore";

function setSlotPathInternal(slot: number, projectPath: string, windowId?: number) {
  if (slot < 1 || slot > 8) return { ok: false as const, reason: "invalid_slot" as const };
  const normalized = projectPath.trim();
  if (!normalized) return { ok: false as const, reason: "empty_path" as const };
  if (!fs.existsSync(normalized)) return { ok: false as const, reason: "path_not_found" as const };
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) return { ok: false as const, reason: "not_directory" as const };

  const name = path.basename(normalized);
  const id = `proj-${Buffer.from(normalized).toString("base64url")}`;
  const prev = projectsState.projects[id] ?? ({} as any);
  projectsState.projects[id] = { ...prev, id, path: normalized, name, lastOpenedAt: Date.now() };
  projectsState.slots = projectsState.slots.map((s) => (s.slot === slot ? { slot, projectId: id } : s));
  persistProjectsToDisk();
  broadcast("projects:state", { state: projectsState });

  // If user binds the currently active slot for this window, ensure the service is ready immediately,
  // otherwise the first file open may race before Project Service init.
  const resolvedWindowId = typeof windowId === "number" ? windowId : mainWindow?.id;
  const activeSlotForWindow = typeof resolvedWindowId === "number" ? activeSlotByWindowId.get(resolvedWindowId) ?? 1 : 1;
  if (slot === activeSlotForWindow) {
    try {
      ensureProjectService(id, normalized);
      void sendToProjectService(id, { type: "watcher:start" });
      void sendToProjectService(id, { type: "watcher:setPaused", paused: false });
    } catch {
      // ignore
    }
  }
  return { ok: true as const, projectId: id };
}

export function registerProjectsIpc({ setActiveSlotForWindow }: { setActiveSlotForWindow: (windowId: number, slot: number) => Promise<void> }) {
  ipcMain.handle("projects:get", () => ({ ok: true, state: projectsState }));

  ipcMain.handle("projects:setSlotPath", (event, { slot, path: projectPath }: { slot: number; path: string }) =>
    setSlotPathInternal(slot, projectPath, getWindowFromEvent(event)?.id)
  );

  ipcMain.handle("projects:bindCwd", (event, { slot }: { slot: number }) =>
    setSlotPathInternal(slot, process.cwd(), getWindowFromEvent(event)?.id)
  );

  ipcMain.handle("projects:openFolder", async (event, { slot }: { slot: number }) => {
    const win = getWindowFromEvent(event);
    if (!win) return { ok: false, reason: "no_window" as const };
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true };
    return setSlotPathInternal(slot, res.filePaths[0], win.id);
  });

  ipcMain.handle("projects:setActiveSlot", async (event, { slot }: { slot: number }) => {
    if (typeof slot !== "number" || slot < 1 || slot > 8) return { ok: false, reason: "invalid_slot" as const };
    const win = getWindowFromEvent(event);
    const windowId = win?.id;
    if (typeof windowId === "number") await setActiveSlotForWindow(windowId, slot);
    return { ok: true };
  });

  ipcMain.handle("projects:unbindSlot", async (_event, { slot }: { slot: number }) => {
    if (typeof slot !== "number" || slot < 1 || slot > 8) return { ok: false, reason: "invalid_slot" as const };
    const previousProjectId = projectsState.slots.find((s) => s.slot === slot)?.projectId;
    projectsState.slots = projectsState.slots.map((s) => (s.slot === slot ? { slot, projectId: undefined } : s));
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });

    clearSlotStaging(slot);
    broadcastAiStatus(slot, "idle");

    if (previousProjectId) {
      try {
        await sendToProjectService(previousProjectId, { type: "watcher:setPaused", paused: true });
        scheduleFreeze(previousProjectId);
      } catch {
        // ignore
      }
    }
    return { ok: true };
  });

  ipcMain.handle("projects:reorderSlots", (_event, { slotOrder }: { slotOrder: number[] }) => {
    if (!Array.isArray(slotOrder) || slotOrder.length !== 8) return { ok: false, reason: "invalid_slot_order" as const };
    const normalized = Array.from(new Set(slotOrder)).filter((n) => typeof n === "number" && n >= 1 && n <= 8);
    if (normalized.length !== 8) return { ok: false, reason: "invalid_slot_order" as const };
    projectsState.slotOrder = normalized;
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });
    return { ok: true };
  });

  ipcMain.handle("projects:setUiLayout", (_event, { projectId, layout }: { projectId: string; layout: UiLayout }) => {
    const project = projectsState.projects[projectId];
    if (!project) return { ok: false, reason: "project_not_found" as const };
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
    const next: UiLayout = {
      explorerWidth: clamp(Number(layout?.explorerWidth) || 180, 180, 520),
      chatWidth: clamp(Number(layout?.chatWidth) || 530, 220, 640),
      isExplorerVisible: Boolean(layout?.isExplorerVisible),
      isChatVisible: Boolean(layout?.isChatVisible)
    };
    projectsState.projects[projectId] = { ...project, uiLayout: next };
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });
    return { ok: true };
  });

  ipcMain.handle("projects:getWorkflow", (_event, { projectId }: { projectId: string }) => {
    const project = projectsState.projects[projectId];
    if (!project) return { ok: false, reason: "project_not_found" as const };
    const stage = project.workflow?.stage;
    const workflow =
      stage === "idea" || stage === "auto" || stage === "preview" || stage === "develop"
        ? project.workflow
        : { stage: "develop" as const, lastUpdatedAt: Date.now() };
    return { ok: true, workflow };
  });

  ipcMain.handle("projects:setWorkflow", (_event, { projectId, workflow }: { projectId: string; workflow: Partial<ProjectWorkflow> }) => {
    const project = projectsState.projects[projectId];
    if (!project) return { ok: false, reason: "project_not_found" as const };
    const stage = String((workflow as any)?.stage ?? "");
    if (stage !== "idea" && stage !== "auto" && stage !== "preview" && stage !== "develop") {
      return { ok: false, reason: "invalid_stage" as const };
    }

    const prev = project.workflow ?? { stage: "develop" as const };
    const next: ProjectWorkflow = { ...prev, ...workflow, stage: stage as WorkflowStage, lastUpdatedAt: Date.now() };
    projectsState.projects[projectId] = { ...project, workflow: next };
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });
    return { ok: true };
  });
}
