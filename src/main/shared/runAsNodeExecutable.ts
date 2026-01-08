import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Returns the best executable to run a Node-mode (ELECTRON_RUN_AS_NODE=1) worker.
 *
 * On macOS packaged apps, spawning the main app binary can show an extra Dock/Desktop app.
 * The Helper app is marked LSUIElement=true so it runs in the background without a Dock icon.
 */
export function resolveRunAsNodeExecutablePath(): string {
  if (process.platform !== "darwin" || !app.isPackaged) return process.execPath;

  const helperFromProcess = (process as any).helperExecPath;
  if (typeof helperFromProcess === "string" && helperFromProcess && fs.existsSync(helperFromProcess)) return helperFromProcess;

  try {
    const appName = app.getName();
    const macosDir = path.dirname(process.execPath); // .../Contents/MacOS
    const contentsDir = path.resolve(macosDir, ".."); // .../Contents
    const helperExe = path.join(contentsDir, "Frameworks", `${appName} Helper.app`, "Contents", "MacOS", `${appName} Helper`);
    if (fs.existsSync(helperExe)) return helperExe;
  } catch {
    // ignore
  }

  return process.execPath;
}

