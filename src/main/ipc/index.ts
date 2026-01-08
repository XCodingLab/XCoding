import type { AppSettings } from "../stores/settingsStore";
import { getProjectForSlot } from "../stores/projectsStore";
import { sendToProjectService } from "../managers/projectServiceManager";
import { registerAiIpc } from "./aiIpc";
import { registerCodexIpc } from "./codexIpc";
import { registerPreviewIpc } from "./previewIpc";
import { registerProjectIpc } from "./projectIpc";
import { registerProjectsIpc } from "./projectsIpc";
import { registerSettingsIpc } from "./settingsIpc";
import { registerTerminalIpc } from "./terminalIpc";
import { registerThemesIpc } from "./themesIpc";
import { registerWindowIpc } from "./windowIpc";

export function setupIpc({
  devServerUrl,
  onLastWindowClosed,
  onLanguageChanged,
  setActiveSlotForWindow
}: {
  devServerUrl: string;
  onLastWindowClosed: () => void;
  onLanguageChanged: (language: AppSettings["ui"]["language"]) => void;
  setActiveSlotForWindow: (windowId: number, slot: number) => Promise<void>;
}) {
  registerSettingsIpc({ onLanguageChanged });
  registerThemesIpc();
  registerWindowIpc({ devServerUrl, onLastWindowClosed, setActiveSlotForWindow });

  registerProjectsIpc({ setActiveSlotForWindow });
  registerProjectIpc();

  registerAiIpc({ getProjectForSlot, sendToProjectService });
  registerCodexIpc();
  registerTerminalIpc({ getProjectForSlot });
  registerPreviewIpc();
}
