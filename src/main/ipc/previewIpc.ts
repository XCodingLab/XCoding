import { ipcMain } from "electron";
import { createPreview, destroyPreview, hidePreview, navigatePreview, setPreviewBounds, showPreview } from "../managers/previewManager";

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

  ipcMain.handle("preview:destroy", (_event, { previewId }: { previewId: string }) => destroyPreview(previewId));
}

