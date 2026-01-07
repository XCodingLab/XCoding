import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export type AppSettings = {
  ui: {
    language: "en-US" | "zh-CN";
    theme: "dark" | "light";
    layout?: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean };
  };
  ai: {
    autoApplyAll: boolean;
    apiBase: string;
    apiKey: string;
    model: string;
    codex: { prewarm: boolean };
  };
};

export type UiLayout = NonNullable<AppSettings["ui"]["layout"]>;

export const settings: AppSettings = {
  ui: { language: "en-US", theme: "dark", layout: { explorerWidth: 180, chatWidth: 530, isExplorerVisible: true, isChatVisible: true } },
  ai: { autoApplyAll: true, apiBase: "https://api.openai.com", apiKey: "", model: "gpt-4o-mini", codex: { prewarm: true } }
};

export function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettingsFromDisk() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    if (parsed.ui?.language === "en-US" || parsed.ui?.language === "zh-CN") settings.ui.language = parsed.ui.language;
    if (parsed.ui?.theme === "dark" || parsed.ui?.theme === "light") settings.ui.theme = parsed.ui.theme;
    let didMigrateLayout = false;
    if (parsed.ui?.layout) {
      const l = parsed.ui.layout as any;
      const rawExplorerWidth = typeof l.explorerWidth === "number" ? (l.explorerWidth as number) : undefined;
      const rawChatWidth = typeof l.chatWidth === "number" ? (l.chatWidth as number) : undefined;
      const rawIsExplorerVisible = typeof l.isExplorerVisible === "boolean" ? (l.isExplorerVisible as boolean) : undefined;
      const rawIsChatVisible = typeof l.isChatVisible === "boolean" ? (l.isChatVisible as boolean) : undefined;

      let explorerWidth = rawExplorerWidth ?? settings.ui.layout?.explorerWidth ?? 180;
      const chatWidth = rawChatWidth ?? settings.ui.layout?.chatWidth ?? 530;
      const isExplorerVisible = rawIsExplorerVisible ?? settings.ui.layout?.isExplorerVisible ?? true;
      const isChatVisible = rawIsChatVisible ?? settings.ui.layout?.isChatVisible ?? true;

      // Migrate legacy default (266) to the new default (210) only when the entire layout matches the old defaults.
      const looksLikeLegacyDefault =
        rawExplorerWidth === 266 && rawChatWidth === 324 && rawIsExplorerVisible === true && rawIsChatVisible === true;
      if (looksLikeLegacyDefault) {
        explorerWidth = 180;
        didMigrateLayout = true;
      }

      settings.ui.layout = { explorerWidth, chatWidth, isExplorerVisible, isChatVisible };
    }
    if (typeof parsed.ai?.autoApplyAll === "boolean") settings.ai.autoApplyAll = parsed.ai.autoApplyAll;
    if (typeof parsed.ai?.apiBase === "string") settings.ai.apiBase = parsed.ai.apiBase;
    if (typeof parsed.ai?.apiKey === "string") settings.ai.apiKey = parsed.ai.apiKey;
    if (typeof parsed.ai?.model === "string") settings.ai.model = parsed.ai.model;
    if (typeof parsed.ai?.codex?.prewarm === "boolean") settings.ai.codex.prewarm = parsed.ai.codex.prewarm;
    if (didMigrateLayout) persistSettingsToDisk();
  } catch {
    // ignore
  }
}

export function persistSettingsToDisk() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // ignore
  }
}

