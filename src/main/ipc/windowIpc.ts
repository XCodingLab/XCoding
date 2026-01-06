import { app, ipcMain } from "electron";
import path from "node:path";
import {
  activeSlotByWindowId,
  broadcastDetachedSlots,
  createWindow,
  findSingleWindowForSlot,
  focusWindow,
  getWindowFromEvent,
  listDetachedSlots,
  mainWindow,
  singleSlotByWindowId
} from "../app/windowManager";

export function registerWindowIpc({
  devServerUrl,
  onLastWindowClosed,
  setActiveSlotForWindow
}: {
  devServerUrl: string;
  onLastWindowClosed: () => void;
  setActiveSlotForWindow: (windowId: number, slot: number) => Promise<void>;
}) {
  ipcMain.handle("window:minimize", (event) => {
    const win = getWindowFromEvent(event) ?? mainWindow;
    win?.minimize();
    return { ok: true };
  });

  ipcMain.handle("window:maximizeToggle", (event) => {
    const win = getWindowFromEvent(event) ?? mainWindow;
    if (!win) return { ok: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle("window:close", (event) => {
    const win = getWindowFromEvent(event) ?? mainWindow;
    win?.close();
    return { ok: true };
  });

  ipcMain.handle("window:getDetachedSlots", () => ({ ok: true, slots: listDetachedSlots() }));

  ipcMain.handle("window:new", async (_event, { slot, mode }: { slot?: number; mode?: "single" | "multi" }) => {
    const desiredSlot = typeof slot === "number" && slot >= 1 && slot <= 8 ? slot : 1;
    const desiredMode = mode === "single" || mode === "multi" ? mode : "multi";

    if (desiredMode === "single") {
      const existing = findSingleWindowForSlot(desiredSlot);
      if (existing) {
        focusWindow(existing);
        void setActiveSlotForWindow(existing.id, desiredSlot);
        return { ok: true, windowId: existing.id, reused: true };
      }
    }

    const win = createWindow({ devServerUrl, onLastWindowClosed });
    activeSlotByWindowId.set(win.id, desiredSlot);
    if (desiredMode === "single") singleSlotByWindowId.set(win.id, desiredSlot);
    else singleSlotByWindowId.delete(win.id);
    broadcastDetachedSlots();
    try {
      // Reload URL with desired slot (works for both dev and packaged).
      const qs = `?slot=${desiredSlot}&windowMode=${desiredMode}`;
      if (!app.isPackaged) await win.loadURL(`${devServerUrl}${qs}`);
      else await win.loadFile(path.join(__dirname, "../index.html"), { search: qs });
    } catch {
      if (desiredMode === "single") {
        singleSlotByWindowId.delete(win.id);
        broadcastDetachedSlots();
      }
    }
    return { ok: true, windowId: win.id };
  });
}

