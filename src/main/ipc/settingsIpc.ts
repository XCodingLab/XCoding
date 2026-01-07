import { ipcMain } from "electron";
import { persistSettingsToDisk, settings, type AppSettings } from "../stores/settingsStore";

export function registerSettingsIpc({
  onLanguageChanged
}: {
  onLanguageChanged: (language: AppSettings["ui"]["language"]) => void;
}) {
  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("settings:setLanguage", (_event, { language }: { language: AppSettings["ui"]["language"] }) => {
    settings.ui.language = language;
    persistSettingsToDisk();
    onLanguageChanged(settings.ui.language);
    return { ok: true };
  });

  ipcMain.handle("settings:setTheme", (_event, { theme }: { theme: AppSettings["ui"]["theme"] }) => {
    settings.ui.theme = theme;
    persistSettingsToDisk();
    return { ok: true };
  });

  ipcMain.handle("settings:setAiConfig", (_event, { apiBase, apiKey, model }: { apiBase: string; apiKey: string; model: string }) => {
    settings.ai.apiBase = apiBase;
    settings.ai.apiKey = apiKey;
    settings.ai.model = model;
    persistSettingsToDisk();
    return { ok: true };
  });

  ipcMain.handle("settings:setAutoApply", (_event, { enabled }: { enabled: boolean }) => {
    settings.ai.autoApplyAll = enabled;
    persistSettingsToDisk();
    return { ok: true };
  });

  ipcMain.handle(
    "settings:setLayout",
    (
      _event,
      {
        explorerWidth,
        chatWidth,
        isExplorerVisible,
        isChatVisible
      }: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean }
    ) => {
      const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
      settings.ui.layout = {
        explorerWidth: clamp(Number(explorerWidth) || 180, 180, 520),
        chatWidth: clamp(Number(chatWidth) || 530, 220, 640),
        isExplorerVisible: Boolean(isExplorerVisible),
        isChatVisible: Boolean(isChatVisible)
      };
      persistSettingsToDisk();
      return { ok: true };
    }
  );
}

