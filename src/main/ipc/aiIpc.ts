import { ipcMain } from "electron";
import type { ProjectServiceRequestNoId, ProjectServiceResponse } from "../shared/projectServiceProtocol";
import { settings } from "../stores/settingsStore";
import { applyAll, cancelChat, getStaging, revertLast, stageEdits, startChat } from "../managers/aiManager";

export function registerAiIpc({
  getProjectForSlot,
  sendToProjectService
}: {
  getProjectForSlot: (slot: number) => { id: string; path: string } | null;
  sendToProjectService: (projectId: string, payload: ProjectServiceRequestNoId) => Promise<ProjectServiceResponse>;
}) {
  ipcMain.handle(
    "ai:chatStart",
    (_event, { slot, requestId, messages }: { slot: number; requestId: string; messages: Array<{ role: string; content: string }> }) =>
      startChat({
        slot,
        requestId,
        messages,
        apiBase: settings.ai.apiBase,
        apiKey: settings.ai.apiKey,
        model: settings.ai.model
      })
  );

  ipcMain.handle("ai:chatCancel", (_event, { slot, requestId }: { slot: number; requestId: string }) => cancelChat({ slot, requestId }));

  ipcMain.handle("ai:stageEdits", (_event, { slot, fileEdits }: { slot: number; fileEdits: Array<{ path: string; content: string }> }) =>
    stageEdits(slot, fileEdits)
  );

  ipcMain.handle("ai:getStaging", (_event, { slot }: { slot: number }) => getStaging(slot));

  ipcMain.handle("ai:applyAll", async (_event, { slot }: { slot: number }) => applyAll({ slot, getProjectForSlot, sendToProjectService }));

  ipcMain.handle("ai:revertLast", async (_event, { slot }: { slot: number }) => revertLast({ slot, getProjectForSlot, sendToProjectService }));
}

