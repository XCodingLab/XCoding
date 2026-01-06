import { BrowserView } from "electron";
import { broadcast, mainWindow } from "../app/windowManager";

type PreviewEntry = {
  id: string;
  view: BrowserView;
  url: string;
};

const previews = new Map<string, PreviewEntry>();
let activePreviewId: string | null = null;

function attachPreviewDebugger(previewId: string, view: BrowserView) {
  const wc = view.webContents;
  const debuggerApi = wc.debugger;
  try {
    debuggerApi.attach("1.3");
  } catch {
    return;
  }

  debuggerApi.on("message", (_event, method, params) => {
    if (method === "Runtime.consoleAPICalled") {
      const level = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args.map((a: { value?: unknown; description?: unknown }) => String(a.value ?? a.description ?? "")).join(" ");
      broadcast("preview:console", { previewId, level, text, timestamp: Date.now() });
      return;
    }

    if (method === "Network.responseReceived") {
      const response = params.response ?? {};
      broadcast("preview:network", {
        previewId,
        requestId: String(params.requestId ?? ""),
        url: String(response.url ?? ""),
        status: Number(response.status ?? 0),
        method: String(params.type ?? ""),
        timestamp: Date.now()
      });
    }
  });

  void debuggerApi.sendCommand("Runtime.enable");
  void debuggerApi.sendCommand("Network.enable");
}

export function createPreview(previewId: string, url: string) {
  if (!mainWindow) return { ok: false as const, reason: "no_window" as const };
  if (previews.has(previewId)) return { ok: true as const };

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  previews.set(previewId, { id: previewId, view, url });
  attachPreviewDebugger(previewId, view);
  void view.webContents.loadURL(url);
  return { ok: true as const };
}

export function showPreview(previewId: string, bounds: { x: number; y: number; width: number; height: number }) {
  if (!mainWindow) return { ok: false as const, reason: "no_window" as const };
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };

  if (activePreviewId && activePreviewId !== previewId) {
    const prev = previews.get(activePreviewId);
    if (prev) mainWindow.removeBrowserView(prev.view);
  }
  activePreviewId = previewId;

  mainWindow.addBrowserView(entry.view);
  entry.view.setBounds(bounds);
  entry.view.setAutoResize({ width: false, height: false });
  return { ok: true as const };
}

export function hidePreview(previewId: string) {
  if (!mainWindow) return { ok: true as const };
  if (!activePreviewId || activePreviewId !== previewId) return { ok: true as const };
  const entry = previews.get(previewId);
  if (entry) mainWindow.removeBrowserView(entry.view);
  activePreviewId = null;
  return { ok: true as const };
}

export function setPreviewBounds(previewId: string, bounds: { x: number; y: number; width: number; height: number }) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  entry.view.setBounds(bounds);
  return { ok: true as const };
}

export function navigatePreview(previewId: string, url: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  entry.url = url;
  void entry.view.webContents.loadURL(url);
  return { ok: true as const };
}

export function destroyPreview(previewId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: true as const };
  if (mainWindow) mainWindow.removeBrowserView(entry.view);
  try {
    entry.view.webContents.debugger.detach();
  } catch {
    // ignore
  }
  entry.view.webContents.close();
  previews.delete(previewId);
  if (activePreviewId === previewId) activePreviewId = null;
  return { ok: true as const };
}

