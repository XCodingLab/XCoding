// 主题 IPC：向渲染进程提供主题包列表与解析后的主题数据，并提供打开主题目录的入口。
import { dialog, ipcMain, shell } from "electron";
import { getWindowFromEvent } from "../app/windowManager";
import { ensureThemesRoot, importThemePackFromZip, listThemePacks, resolveThemePack, themesRootPath } from "../managers/themeManager";

export function registerThemesIpc() {
  ipcMain.handle("themes:list", () => {
    ensureThemesRoot();
    return listThemePacks();
  });

  ipcMain.handle("themes:getResolved", (_event, { id }: { id: string }) => {
    ensureThemesRoot();
    return resolveThemePack(id);
  });

  ipcMain.handle("themes:openDir", async () => {
    ensureThemesRoot();
    const p = themesRootPath();
    await shell.openPath(p);
    return { ok: true, path: p };
  });

  ipcMain.handle("themes:importZip", async (event) => {
    ensureThemesRoot();
    const win = getWindowFromEvent(event);
    if (!win) return { ok: false, reason: "no_window" as const };

    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Theme Pack (.zip)", extensions: ["zip"] }]
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true as const };

    const zipPath = res.filePaths[0];
    const imported = await importThemePackFromZip(zipPath, { overwrite: false });

    if (imported.ok) return { ok: true, themeId: imported.themeId, didReplace: imported.didReplace };

    if (imported.reason === "theme_exists" && imported.themeId) {
      const confirm = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Replace", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: `Theme pack "${imported.themeId}" already exists.`,
        detail: "Replace the existing theme pack folder?"
      });

      if (confirm.response !== 0) return { ok: true, canceled: true as const };

      const replaced = await importThemePackFromZip(zipPath, { overwrite: true });
      if (replaced.ok) return { ok: true, themeId: replaced.themeId, didReplace: replaced.didReplace };
      return { ok: false, reason: replaced.reason as string, themeId: imported.themeId };
    }

    return { ok: false, reason: imported.reason as string, themeId: imported.themeId };
  });
}
