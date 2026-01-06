import { ipcMain } from "electron";
import fs from "node:fs";
import { createTerminal, terminalDispose, terminalGetBuffer, terminalResize, terminalWrite } from "../managers/terminalManager";

export function registerTerminalIpc({ getProjectForSlot }: { getProjectForSlot: (slot: number) => { id: string; path: string } | null }) {
  ipcMain.handle("terminal:create", (_event, { slot }: { slot?: number } = {}) => {
    const requestedCwd = typeof slot === "number" ? getProjectForSlot(slot)?.path ?? process.cwd() : process.cwd();
    const cwd = fs.existsSync(requestedCwd) ? requestedCwd : process.cwd();
    return createTerminal({ cwd });
  });

  ipcMain.handle("terminal:write", (_event, { sessionId, data }: { sessionId: string; data: string }) => terminalWrite(sessionId, data));

  ipcMain.handle("terminal:resize", (_event, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) =>
    terminalResize(sessionId, cols, rows)
  );

  ipcMain.handle("terminal:getBuffer", (_event, { sessionId, maxBytes }: { sessionId: string; maxBytes?: number }) =>
    terminalGetBuffer(sessionId, maxBytes)
  );

  ipcMain.handle("terminal:dispose", (_event, { sessionId }: { sessionId: string }) => terminalDispose(sessionId));
}

