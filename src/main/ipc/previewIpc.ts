import { ipcMain } from "electron";
import {
  createPreview,
  destroyPreview,
  hidePreview,
  navigatePreview,
  previewNetworkBuildCurl,
  previewNetworkClearBrowserCache,
  previewNetworkGetEntry,
  previewNetworkGetResponseBody,
  reloadPreview,
  setPreviewBounds,
  setPreviewEmulation,
  setPreviewPreserveLog,
  showPreview
} from "../managers/previewManager";

export function registerPreviewIpc() {
  ipcMain.handle("preview:create", (_event, { previewId, url }: { previewId: string; url: string }) => createPreview(previewId, url));

  ipcMain.handle(
    "preview:show",
    (_event, { previewId, bounds }: { previewId: string; bounds: { x: number; y: number; width: number; height: number } }) =>
      showPreview(previewId, bounds)
  );

  ipcMain.handle("preview:hide", (_event, { previewId }: { previewId: string }) => hidePreview(previewId));

  ipcMain.handle("preview:setBounds", (_event, { previewId, bounds }: { previewId: string; bounds: { x: number; y: number; width: number; height: number } }) =>
    setPreviewBounds(previewId, bounds)
  );

  ipcMain.handle("preview:navigate", (_event, { previewId, url }: { previewId: string; url: string }) => navigatePreview(previewId, url));

  ipcMain.handle("preview:reload", (_event, { previewId }: { previewId: string }) => reloadPreview(previewId));

  ipcMain.handle("preview:setPreserveLog", (_event, { previewId, preserveLog }: { previewId: string; preserveLog: boolean }) =>
    setPreviewPreserveLog(previewId, preserveLog)
  );

  ipcMain.handle("preview:setEmulation", (_event, { previewId, mode }: { previewId: string; mode: "desktop" | "phone" | "tablet" }) =>
    setPreviewEmulation(previewId, mode)
  );

  ipcMain.handle("preview:networkGetEntry", (_event, { previewId, requestId }: { previewId: string; requestId: string }) =>
    previewNetworkGetEntry(previewId, requestId)
  );

  ipcMain.handle("preview:networkGetResponseBody", (_event, { previewId, requestId }: { previewId: string; requestId: string }) =>
    previewNetworkGetResponseBody(previewId, requestId)
  );

  ipcMain.handle("preview:networkBuildCurl", (_event, { previewId, requestId }: { previewId: string; requestId: string }) =>
    previewNetworkBuildCurl(previewId, requestId)
  );

  ipcMain.handle("preview:networkClearBrowserCache", (_event, { previewId }: { previewId: string }) => previewNetworkClearBrowserCache(previewId));

  ipcMain.handle("preview:destroy", (_event, { previewId }: { previewId: string }) => destroyPreview(previewId));
}
