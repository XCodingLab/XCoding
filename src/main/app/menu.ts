import { Menu, app, shell } from "electron";
import type { AppSettings } from "../stores/settingsStore";

const mainMenuMessages = {
  "en-US": {
    help: "Help",
    openUserDataFolder: "Open UserData Folder"
  },
  "zh-CN": {
    help: "帮助",
    openUserDataFolder: "打开 UserData 目录"
  }
} as const;

export function setupAppMenu(appName: string, language: AppSettings["ui"]["language"]) {
  const openUserDataFolder = async () => {
    try {
      await shell.openPath(app.getPath("userData"));
    } catch {
      // ignore
    }
  };

  const t = (key: keyof (typeof mainMenuMessages)["en-US"]) => mainMenuMessages[language][key];

  const macAppMenu: Electron.MenuItemConstructorOptions | null = process.platform === "darwin"
    ? {
        label: appName,
        submenu: [
          { role: "about", label: `About ${appName}` },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `Hide ${appName}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${appName}` }
        ]
      }
    : null;

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(macAppMenu ? [macAppMenu] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: t("help"),
      role: "help",
      submenu: [{ label: t("openUserDataFolder"), click: () => void openUserDataFolder() }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

