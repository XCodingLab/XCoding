import { BrowserWindow, app, globalShortcut, net, protocol } from "electron";
import { pathToFileURL } from "node:url";
import { setupAppMenu } from "./app/menu";
import { registerShortcuts } from "./app/shortcuts";
import {
  activeSlotByWindowId,
  broadcast,
  broadcastDetachedSlots,
  createWindow,
  listDetachedSlots,
  sendToWindow,
  singleSlotByWindowId,
} from "./app/windowManager";
import { broadcastAiStatus } from "./managers/aiManager";
import { disposeCodexBridge, disposeCodexBridgeForUiGone, ensureCodexBridge } from "./managers/codexManager";
import { cancelScheduledFreeze, ensureProjectService, getProjectServiceEntry, scheduleFreeze, sendToProjectService } from "./managers/projectServiceManager";
import { setupIpc } from "./ipc";
import { disposeAllTerminals } from "./managers/terminalManager";
import { getProjectForSlot, loadProjectsFromDisk, projectsState } from "./stores/projectsStore";
import { loadSettingsFromDisk, settings } from "./stores/settingsStore";
import { disposeAllClaudeSync } from "./claude/claudeManager";

const APP_NAME = "XCoding";
app.name = APP_NAME;
try {
  app.setName(APP_NAME);
} catch {
  // ignore
}

// In dev, Electron prints security warnings for any renderer that loads a page without CSP
// (e.g. BrowserView previewing arbitrary websites). These warnings do not appear once packaged.
if (!app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const DEV_SERVER_URL = "http://127.0.0.1:5173";

// Ensure only one IDE instance runs at a time.
// This guarantees we only ever spawn a single `codex app-server` for the whole IDE,
// even if the user tries to launch multiple instances.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance, create another window in the same process.
    // This preserves the "only one codex app-server" invariant while supporting multi-window UX.
    const win = createWindow({ devServerUrl: DEV_SERVER_URL, onLastWindowClosed: onLastWindowClosedCleanup });
    try {
      win.show();
      win.focus();
    } catch {
      // ignore
    }
  });
}

// Best-effort: try to terminate codex app-server on abnormal exits too.
// This cannot help when the OS force-kills the process, but reduces orphaning in most cases.
process.on("SIGINT", () => {
  disposeCodexBridge("SIGINT");
  disposeAllClaudeSync("SIGINT");
});
process.on("SIGTERM", () => {
  disposeCodexBridge("SIGTERM");
  disposeAllClaudeSync("SIGTERM");
});
process.on("beforeExit", () => {
  disposeCodexBridge("beforeExit");
  disposeAllClaudeSync("beforeExit");
});
process.on("exit", () => {
  disposeCodexBridge("exit");
  disposeAllClaudeSync("exit");
});
process.on("uncaughtException", () => {
  disposeCodexBridge("uncaughtException");
  disposeAllClaudeSync("uncaughtException");
});
process.on("unhandledRejection", () => {
  disposeCodexBridge("unhandledRejection");
  disposeAllClaudeSync("unhandledRejection");
});

// macOS menu title & About panel title
if (process.platform === "darwin") {
  try {
    app.setAboutPanelOptions({
      applicationName: "XCoding",
      applicationVersion: app.getVersion()
    });
  } catch {
    // ignore
  }
}

function getBoundSlotsInOrder(): number[] {
  const order =
    projectsState.slotOrder?.length === 8 ? projectsState.slotOrder : Array.from({ length: 8 }).map((_, idx) => idx + 1);
  const bound = new Set<number>();
  for (const s of projectsState.slots) {
    if (s.projectId) bound.add(s.slot);
  }
  return order.filter((slot) => bound.has(slot));
}

function getVisibleBoundSlotsForWindow(windowId: number): number[] {
  const boundSlots = getBoundSlotsInOrder();
  const singleSlot = singleSlotByWindowId.get(windowId);
  if (typeof singleSlot === "number") return boundSlots.includes(singleSlot) ? [singleSlot] : [];

  const detached = new Set(listDetachedSlots());
  return boundSlots.filter((slot) => !detached.has(slot));
}

function onLastWindowClosedCleanup() {
  disposeCodexBridgeForUiGone();
  disposeAllClaudeSync("ui-gone");
}

async function setActiveSlotForWindow(windowId: number, slot: number) {
  if (typeof windowId !== "number") return;
  if (typeof slot !== "number" || slot < 1 || slot > 8) return;

  activeSlotByWindowId.set(windowId, slot);
  sendToWindow(windowId, "projects:switchSlot", { slot });

  // Recompute which projects are active across ALL windows.
  const activeProjectIds = new Set<string>();
  for (const s of activeSlotByWindowId.values()) {
    const p = getProjectForSlot(s);
    if (p?.id) activeProjectIds.add(p.id);
  }

  for (const { projectId } of projectsState.slots) {
    if (!projectId) continue;
    const service = getProjectServiceEntry(projectId);
    const isActive = activeProjectIds.has(projectId);

    if (isActive) {
      const proj = projectsState.projects[projectId];
      if (proj?.path) {
        ensureProjectService(projectId, proj.path);
        await sendToProjectService(projectId, { type: "watcher:start" });
      }
    }

    if (service) await sendToProjectService(projectId, { type: "watcher:setPaused", paused: !isActive });
    if (isActive) {
      cancelScheduledFreeze(projectId);
    } else {
      scheduleFreeze(projectId);
    }
  }
}


app.whenReady().then(() => {
  // Ensure name sticks after Electron initializes (affects macOS menu title in dev builds).
  try {
    app.name = APP_NAME;
    app.setName(APP_NAME);
  } catch {
    // ignore
  }
  if (process.platform === "darwin") {
    try {
      app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: app.getVersion()
      });
    } catch {
      // ignore
    }
  }

  // Support `local-file://...` URLs for Markdown preview images (aligned with EnsoAI).
  protocol.handle("local-file", (request) => {
    const raw = decodeURIComponent(request.url.slice("local-file://".length));
    const filePath = raw.startsWith("/") && /^[a-zA-Z]:[\\/]/.test(raw.slice(1)) ? raw.slice(1) : raw;
    const fileUrl = pathToFileURL(filePath).toString();
    return net.fetch(fileUrl);
  });

  loadSettingsFromDisk();
  loadProjectsFromDisk();
  const win = createWindow({ devServerUrl: DEV_SERVER_URL, onLastWindowClosed: onLastWindowClosedCleanup });
  void setActiveSlotForWindow(win.id, activeSlotByWindowId.get(win.id) ?? 1);
  setupAppMenu(APP_NAME, settings.ui.language);
  setupIpc({
    devServerUrl: DEV_SERVER_URL,
    onLastWindowClosed: onLastWindowClosedCleanup,
    onLanguageChanged: (language) => setupAppMenu(APP_NAME, language),
    setActiveSlotForWindow
  });
  registerShortcuts({ getVisibleBoundSlotsForWindow, setActiveSlotForWindow });
  for (let slot = 1; slot <= 8; slot += 1) broadcastAiStatus(slot, "idle");
  broadcast("projects:state", { state: projectsState });
  broadcastDetachedSlots();

  if (settings.ai.codex.prewarm) {
    const schedulePrewarm = () => {
      // Delay until after the window is usable to reduce cold-start peak memory.
      setTimeout(() => {
        if (win.isDestroyed()) return;
        void ensureCodexBridge()
          .ensureStarted()
          .catch(() => void 0);
      }, 1500);
    };

    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", schedulePrewarm);
    else schedulePrewarm();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ devServerUrl: DEV_SERVER_URL, onLastWindowClosed: onLastWindowClosedCleanup });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  disposeAllTerminals();

  disposeCodexBridgeForUiGone();
  disposeAllClaudeSync("will-quit");
});
