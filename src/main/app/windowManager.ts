import { BrowserWindow, app, screen } from "electron";
import path from "node:path";

export let mainWindow: BrowserWindow | null = null;
export const windowsById = new Map<number, BrowserWindow>();

// Per-window active slot. Default slot=1 for the first window.
export const activeSlotByWindowId = new Map<number, number>();
// Track "single project windows" so we can route global hotkeys to the correct window.
export const singleSlotByWindowId = new Map<number, number>();

const cspInstalledSessions = new WeakSet<Electron.Session>();

function installMainWindowCsp(win: BrowserWindow) {
  // Dev server relies on inline scripts (Vite/React refresh preamble). Enforcing strict CSP in dev breaks startup.
  // Electron's CSP warning is mainly relevant for packaged apps; we enforce CSP only when packaged.
  if (!app.isPackaged) return;

  const session = win.webContents.session;
  if (cspInstalledSessions.has(session)) return;
  cspInstalledSessions.add(session);

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: local-file: https: http:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self'"
  ].join("; ");

  session.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || "";
    const isMainUi = url.startsWith("file://");
    if (!isMainUi) {
      callback({ cancel: false, responseHeaders: details.responseHeaders });
      return;
    }

    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    responseHeaders["Content-Security-Policy"] = [csp];
    callback({ cancel: false, responseHeaders });
  });
}

export function broadcast(channel: string, payload: unknown) {
  for (const win of windowsById.values()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // ignore
    }
  }
}

export function sendToWindow(windowId: number, channel: string, payload: unknown) {
  const win = windowsById.get(windowId);
  if (!win) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    // ignore
  }
}

export function getWindowFromEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

export function listDetachedSlots(): number[] {
  const slots = new Set<number>();
  for (const slot of singleSlotByWindowId.values()) slots.add(slot);
  return Array.from(slots).sort((a, b) => a - b);
}

export function broadcastDetachedSlots() {
  broadcast("window:detachedSlots", { slots: listDetachedSlots() });
}

export function findSingleWindowForSlot(slot: number): BrowserWindow | null {
  for (const [windowId, singleSlot] of singleSlotByWindowId) {
    if (singleSlot !== slot) continue;
    const win = windowsById.get(windowId);
    if (win) return win;
  }
  return null;
}

export function focusWindow(win: BrowserWindow) {
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch {
    // ignore
  }
}

export function createWindow({
  devServerUrl,
  onLastWindowClosed
}: {
  devServerUrl: string;
  onLastWindowClosed: () => void;
}): BrowserWindow {
  const shouldOpenDevTools =
    !app.isPackaged || process.env.XCODING_OPEN_DEVTOOLS === "1" || process.argv.includes("--open-devtools");

  const baseWidth = 1280;
  const baseHeight = 800;
  const scale = 1.2;
  const targetWidth = Math.round(baseWidth * scale);
  const targetHeight = Math.round(baseHeight * scale);
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(targetWidth, workArea.width),
    height: Math.min(targetHeight, workArea.height),
    backgroundColor: "#0a0a0a",
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  installMainWindowCsp(win);

  windowsById.set(win.id, win);
  if (!activeSlotByWindowId.has(win.id)) activeSlotByWindowId.set(win.id, 1);

  win.on("closed", () => {
    windowsById.delete(win.id);
    activeSlotByWindowId.delete(win.id);
    singleSlotByWindowId.delete(win.id);
    broadcastDetachedSlots();
    if (mainWindow === win) mainWindow = BrowserWindow.getAllWindows()[0] ?? null;
    if (BrowserWindow.getAllWindows().length === 0) onLastWindowClosed();
  });

  if (!app.isPackaged) {
    const slot = activeSlotByWindowId.get(win.id) ?? 1;
    win.loadURL(`${devServerUrl}?slot=${slot}&windowMode=multi`);
    if (shouldOpenDevTools) win.webContents.openDevTools({ mode: "detach" });
    if (!mainWindow) mainWindow = win;
    return win;
  }

  const slot = activeSlotByWindowId.get(win.id) ?? 1;
  void win.loadFile(path.join(__dirname, "../index.html"), { search: `?slot=${slot}&windowMode=multi` });
  if (shouldOpenDevTools) win.webContents.openDevTools({ mode: "detach" });
  if (!mainWindow) mainWindow = win;
  return win;
}
