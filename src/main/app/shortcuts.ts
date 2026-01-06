import { BrowserWindow, globalShortcut } from "electron";
import { windowsById } from "./windowManager";

export function registerShortcuts({
  getVisibleBoundSlotsForWindow,
  setActiveSlotForWindow
}: {
  getVisibleBoundSlotsForWindow: (windowId: number) => number[];
  setActiveSlotForWindow: (windowId: number, slot: number) => Promise<void>;
}) {
  for (let i = 1; i <= 8; i += 1) {
    const accelerator = `CommandOrControl+${i}`;
    globalShortcut.register(accelerator, () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win || !windowsById.has(win.id)) return;
      const slots = getVisibleBoundSlotsForWindow(win.id);
      const targetSlot = slots[i - 1];
      if (typeof targetSlot !== "number") return;
      void setActiveSlotForWindow(win.id, targetSlot);
    });
  }
}

