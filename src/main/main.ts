import { BrowserView, BrowserWindow, Menu, app, clipboard, dialog, globalShortcut, ipcMain, net, protocol, screen, shell } from "electron";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexBridge } from "./codexBridge";
import { ensureCodexExecutableIsRunnable, resolveCodexExecutablePath } from "./codexExecutable";

const APP_NAME = "XCoding";
app.name = APP_NAME;
try {
  app.setName(APP_NAME);
} catch {
  // ignore
}

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
    const win = createWindow();
    try {
      win.show();
      win.focus();
    } catch {
      // ignore
    }
  });
}

function sanitizeShellEnv(env: Record<string, string | undefined>) {
  // nvm warns (and can refuse to work) when npm_config_prefix is set (often set by pnpm global prefix).
  // We sanitize the terminal environment to be closer to a "login shell" and avoid tool conflicts.
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  return env;
}

type AppSettings = {
  ui: {
    language: "en-US" | "zh-CN";
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

type UiLayout = NonNullable<AppSettings["ui"]["layout"]>;

type ProjectServiceRequest =
  | { id: string; type: "init"; projectPath: string }
  | { id: string; type: "fs:readFile"; relPath: string }
  | { id: string; type: "fs:writeFile"; relPath: string; content: string }
  | { id: string; type: "fs:listDir"; relDir: string }
  | { id: string; type: "fs:searchPaths"; query: string; limit?: number }
  | { id: string; type: "fs:gitStatus"; maxEntries?: number }
  | { id: string; type: "fs:searchFiles"; query: string; maxResults?: number; useGitignore?: boolean }
  | {
      id: string;
      type: "fs:searchContent";
      query: string;
      maxResults?: number;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      regex?: boolean;
      filePattern?: string;
      include?: string[];
      exclude?: string[];
      useGitignore?: boolean;
    }
  | {
      id: string;
      type: "fs:replaceContent";
      query: string;
      replace: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      regex?: boolean;
      filePattern?: string;
      include?: string[];
      exclude?: string[];
      useGitignore?: boolean;
      maxFiles?: number;
      maxMatches?: number;
      maxFileSize?: string;
    }
  | { id: string; type: "fs:deleteFile"; relPath: string }
  | { id: string; type: "fs:deleteDir"; relDir: string }
  | { id: string; type: "fs:stat"; relPath: string }
  | { id: string; type: "fs:mkdir"; relDir: string }
  | { id: string; type: "fs:rename"; from: string; to: string }
  | { id: string; type: "watcher:start" }
  | { id: string; type: "watcher:stop" }
  | { id: string; type: "watcher:setPaused"; paused: boolean }
  | { id: string; type: "lang:ts:diagnostics"; relPath: string; content: string }
  | { id: string; type: "lsp:didOpen"; language: "python" | "go"; relPath: string; languageId: string; content: string }
  | { id: string; type: "lsp:didChange"; language: "python" | "go"; relPath: string; content: string }
  | { id: string; type: "lsp:didClose"; language: "python" | "go"; relPath: string }
  | { id: string; type: "lsp:request"; language: "python" | "go"; method: string; relPath: string; params?: unknown };

type ProjectServiceResponse = { id: string; ok: true; result: any } | { id: string; ok: false; error: string };
type WithoutId<T> = T extends any ? Omit<T, "id"> : never;
type ProjectServiceRequestNoId = WithoutId<ProjectServiceRequest>;

type ProjectRecord = {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number;
  uiLayout?: UiLayout;
  workflow?: ProjectWorkflow;
};

type WorkflowStage = "idea" | "auto" | "preview" | "develop";

type ProjectWorkflow = { stage: WorkflowStage; lastUpdatedAt?: number };

type ProjectsState = {
  schemaVersion: 3;
  slotOrder: number[];
  slots: Array<{ slot: number; projectId?: string }>;
  projects: Record<string, ProjectRecord>;
};

type TerminalSession = {
  id: string;
  kind: "pty" | "proc";
  pty?: IPty;
  proc?: ChildProcessWithoutNullStreams;
  buffer?: string;
};

type PreviewEntry = {
  id: string;
  view: BrowserView;
  url: string;
};

type AiStaging = {
  patchId: string;
  fileEdits: Array<{ path: string; content: string }>;
  snapshot?: Array<{ path: string; existed: boolean; content?: string }>;
  createdAt: number;
  appliedAt?: number;
  revertedAt?: number;
};

let mainWindow: BrowserWindow | null = null;
const windowsById = new Map<number, BrowserWindow>();
const terminalSessions = new Map<string, TerminalSession>();
const previews = new Map<string, PreviewEntry>();
let activePreviewId: string | null = null;
const aiStagingBySlot = new Map<number, AiStaging[]>();
const projectServices = new Map<string, { child: ChildProcess; pending: Map<string, (res: ProjectServiceResponse) => void> }>();
// Per-window active slot. Default slot=1 for the first window.
const activeSlotByWindowId = new Map<number, number>();
// Track "single project windows" so we can route global hotkeys to the correct window.
const singleSlotByWindowId = new Map<number, number>();
const freezeTimers = new Map<string, NodeJS.Timeout>();
const BACKGROUND_FREEZE_MS = 60_000;
let aiService: { child: ChildProcess; pending: Map<string, (res: any) => void> } | null = null;
const aiChatSlotByRequestId = new Map<string, number>();
let codexBridge: CodexBridge | null = null;
let codexHomePath: string | null = null;
const codexPendingRequestsById = new Map<number, { method: string; params: any }>();
let codexLastStatus: { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string } = { state: "idle" };
let codexLastStderr = "";

function disposeCodexBridge(reason: string) {
  try {
    codexBridge?.dispose();
  } catch {
    // ignore
  }
  codexBridge = null;
  if (codexLastStatus.state === "ready" || codexLastStatus.state === "starting") {
    codexLastStatus = { state: "exited", error: `codex_disposed:${reason}` };
  }
}

// Best-effort: try to terminate codex app-server on abnormal exits too.
// This cannot help when the OS force-kills the process, but reduces orphaning in most cases.
process.on("SIGINT", () => disposeCodexBridge("SIGINT"));
process.on("SIGTERM", () => disposeCodexBridge("SIGTERM"));
process.on("beforeExit", () => disposeCodexBridge("beforeExit"));
process.on("exit", () => disposeCodexBridge("exit"));
process.on("uncaughtException", () => disposeCodexBridge("uncaughtException"));
process.on("unhandledRejection", () => disposeCodexBridge("unhandledRejection"));

type CodexTurnSnapshotEntry = { relPath: string; absPath: string; existed: boolean; snapshotFile: string };
type CodexTurnSnapshot = { threadId: string; turnId: string; cwd: string; createdAt: number; entries: CodexTurnSnapshotEntry[] };
const codexTurnSnapshotsByKey = new Map<string, CodexTurnSnapshot>();

const settings: AppSettings = {
  ui: { language: "en-US", layout: { explorerWidth: 180, chatWidth: 530, isExplorerVisible: true, isChatVisible: true } },
  ai: { autoApplyAll: true, apiBase: "https://api.openai.com", apiKey: "", model: "gpt-4o-mini", codex: { prewarm: true } }
};

let projectsState: ProjectsState = {
  schemaVersion: 3,
  slotOrder: Array.from({ length: 8 }).map((_, i) => i + 1),
  slots: Array.from({ length: 8 }).map((_, i) => ({ slot: i + 1 })),
  projects: {}
};

function createWindow(): BrowserWindow {
  const baseWidth = 1280;
  const baseHeight = 800;
  const scale = 1.2;
  const targetWidth = Math.round(baseWidth * scale);
  const targetHeight = Math.round(baseHeight * scale);
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(targetWidth, workArea.width),
    height: Math.min(targetHeight, workArea.height),
    backgroundColor: "#0a0a0a",
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  windowsById.set(win.id, win);
  if (!activeSlotByWindowId.has(win.id)) activeSlotByWindowId.set(win.id, 1);

  win.on("closed", () => {
    windowsById.delete(win.id);
    activeSlotByWindowId.delete(win.id);
    singleSlotByWindowId.delete(win.id);
    broadcastDetachedSlots();
    if (mainWindow === win) mainWindow = BrowserWindow.getAllWindows()[0] ?? null;
    // If the UI goes away (dev window reload/crash/close), proactively stop codex app-server
    // so we don't leave orphaned background processes around.
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        codexBridge?.dispose();
      } catch {
        // ignore
      }
      codexBridge = null;
      codexHomePath = null;
    }
  });

  if (!app.isPackaged) {
    // Support optional slot bootstrap when opening additional windows from the app.
    const slot = activeSlotByWindowId.get(win.id) ?? 1;
    win.loadURL(`${DEV_SERVER_URL}?slot=${slot}&windowMode=multi`);
    win.webContents.openDevTools({ mode: "detach" });
    if (!mainWindow) mainWindow = win;
    return win;
  }

  // In production build, Vite outputs to `dist/` and main process to `dist/main/`.
  // In production build, Vite outputs to `dist/` and main process to `dist/main/`.
// We pass initial slot via query string so renderer can bootstrap.
const slot = activeSlotByWindowId.get(win.id) ?? 1;
win.loadFile(path.join(__dirname, "../index.html"), { search: `?slot=${slot}&windowMode=multi` });
if (!mainWindow) mainWindow = win;
return win;
}

// macOS 菜单显示名称 & 关于面板名称
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

function setupAppMenu(language: AppSettings["ui"]["language"]) {
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
        label: APP_NAME,
        submenu: [
          { role: "about", label: `About ${APP_NAME}` },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `Hide ${APP_NAME}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${APP_NAME}` }
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

function appendTerminalBuffer(sessionId: string, chunk: string) {
  const s = terminalSessions.get(sessionId);
  if (!s) return;
  const next = (s.buffer ?? "") + chunk;
  // Keep ~200KB of recent output to allow UI remount without going blank.
  const MAX = 200_000;
  s.buffer = next.length > MAX ? next.slice(next.length - MAX) : next;
}

function adjustArgsForShell(shell: string, args: string[]): string[] {
  // dash (/bin/sh on Ubuntu) doesn't support login flag "-l".
  if (shell.endsWith("/sh")) return args.filter((a) => a !== "-l");
  return args;
}

function getEnhancedPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (process.platform === "win32") return process.env.PATH || "";

  const currentPath = process.env.PATH || "";
  const additionalPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    path.join(home, "Library", "pnpm"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".nvm", "versions", "node", "current", "bin")
  ];
  const all = Array.from(new Set([...additionalPaths, ...currentPath.split(path.delimiter)])).filter(Boolean);
  return all.join(path.delimiter);
}

function findLoginShellForPty(): { shell: string; args: string[]; label: string }[] {
  if (process.platform === "win32") {
    return [
      { shell: "powershell.exe", args: [], label: "powershell.exe" },
      { shell: "cmd.exe", args: [], label: "cmd.exe" }
    ];
  }

  const candidates: string[] = [];
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) candidates.push(process.env.SHELL);
  candidates.push("/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh");

  const uniq = Array.from(new Set(candidates)).filter((p) => p && fs.existsSync(p));
  return uniq.map((shell) => {
    const args = adjustArgsForShell(shell, ["-l"]);
    return { shell, args, label: args.length ? `${shell} ${args.join(" ")}` : shell };
  });
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function projectsPath() {
  return path.join(app.getPath("userData"), "projects.json");
}

function loadSettingsFromDisk() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    if (parsed.ui?.language === "en-US" || parsed.ui?.language === "zh-CN") settings.ui.language = parsed.ui.language;
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

function persistSettingsToDisk() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function loadProjectsFromDisk() {
  try {
    const raw = fs.readFileSync(projectsPath(), "utf8");
    const parsed = JSON.parse(raw) as { schemaVersion?: number; slots?: unknown; projects?: unknown; slotOrder?: unknown };

    const migrateProjectLayoutDefaults = () => {
      let migrated = false;
      for (const project of Object.values(projectsState.projects)) {
        const l = project.uiLayout;
        if (!l) continue;
        if (l.explorerWidth !== 266 || l.chatWidth !== 324 || l.isExplorerVisible !== true || l.isChatVisible !== true) continue;
        project.uiLayout = { ...l, explorerWidth: 180 };
        migrated = true;
      }
      return migrated;
    };

    const migrateProjectWorkflowDefaults = () => {
      let migrated = false;
      for (const project of Object.values(projectsState.projects)) {
        const stage = project.workflow?.stage;
        if (stage === "idea" || stage === "auto" || stage === "preview" || stage === "develop") continue;
        project.workflow = { stage: "develop", lastUpdatedAt: Date.now() };
        migrated = true;
      }
      return migrated;
    };

    if (parsed.schemaVersion === 1) {
      const v1Slots = Array.isArray(parsed.slots) ? (parsed.slots as any[]) : [];
      const slots = v1Slots
        .filter((s) => typeof s?.slot === "number" && s.slot >= 1 && s.slot <= 8)
        .map((s) => ({ slot: s.slot as number, projectId: typeof s.projectId === "string" ? s.projectId : undefined }));
      for (let i = 1; i <= 8; i += 1) if (!slots.some((s) => s.slot === i)) slots.push({ slot: i, projectId: undefined });
      slots.sort((a, b) => a.slot - b.slot);
      projectsState = {
        schemaVersion: 3,
        slotOrder: Array.from({ length: 8 }).map((_, i) => i + 1),
        slots,
        projects: (parsed.projects && typeof parsed.projects === "object" ? (parsed.projects as any) : {}) as ProjectsState["projects"]
      };
      migrateProjectLayoutDefaults();
      migrateProjectWorkflowDefaults();
      persistProjectsToDisk();
      return;
    }

    if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) return;

    const v2Slots = Array.isArray(parsed.slots) ? (parsed.slots as any[]) : [];
    const slots = v2Slots
      .filter((s) => typeof s?.slot === "number" && s.slot >= 1 && s.slot <= 8)
      .map((s) => ({ slot: s.slot as number, projectId: typeof s.projectId === "string" ? s.projectId : undefined }));
    for (let i = 1; i <= 8; i += 1) if (!slots.some((s) => s.slot === i)) slots.push({ slot: i, projectId: undefined });
    slots.sort((a, b) => a.slot - b.slot);

    const rawOrder = Array.isArray(parsed.slotOrder) ? (parsed.slotOrder as any[]).filter((n) => typeof n === "number") : [];
    const normalized = Array.from(new Set(rawOrder)).filter((n) => n >= 1 && n <= 8);
    const slotOrder = normalized.length === 8 ? (normalized as number[]) : Array.from({ length: 8 }).map((_, i) => i + 1);

    projectsState.schemaVersion = 3;
    projectsState.slotOrder = slotOrder;
    projectsState.slots = slots;
    if (parsed.projects && typeof parsed.projects === "object") projectsState.projects = parsed.projects as ProjectsState["projects"];

    const didMigrateLayout = migrateProjectLayoutDefaults();
    const didMigrateWorkflow = migrateProjectWorkflowDefaults();
    if (didMigrateLayout || didMigrateWorkflow || parsed.schemaVersion === 2) persistProjectsToDisk();
  } catch {
    // ignore
  }
}

function persistProjectsToDisk() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(projectsPath(), JSON.stringify(projectsState, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function broadcast(channel: string, payload: unknown) {
  for (const win of windowsById.values()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // ignore
    }
  }
}

function sendToWindow(windowId: number, channel: string, payload: unknown) {
  const win = windowsById.get(windowId);
  if (!win) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    // ignore
  }
}

function getWindowFromEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

function listDetachedSlots(): number[] {
  const slots = new Set<number>();
  for (const slot of singleSlotByWindowId.values()) slots.add(slot);
  return Array.from(slots).sort((a, b) => a - b);
}

function broadcastDetachedSlots() {
  broadcast("window:detachedSlots", { slots: listDetachedSlots() });
}

function findSingleWindowForSlot(slot: number): BrowserWindow | null {
  for (const [windowId, singleSlot] of singleSlotByWindowId) {
    if (singleSlot !== slot) continue;
    const win = windowsById.get(windowId);
    if (win) return win;
  }
  return null;
}

function focusWindow(win: BrowserWindow) {
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch {
    // ignore
  }
}

function ensureCodexBridge() {
  // 固定使用 ~/.codex（不支持备用回退或用户自定义 CODEX_HOME），以复用 VS Code 插件的历史记录与配置。
  const home = homedir();
  const desiredCodexHome = path.join(home, ".codex");
  const resolvedExe = resolveCodexExecutablePath();
  if (resolvedExe.path) ensureCodexExecutableIsRunnable(resolvedExe.path);
  if (codexBridge && codexHomePath === desiredCodexHome) return codexBridge;
  if (codexBridge) codexBridge.dispose();
  codexHomePath = desiredCodexHome;
  codexBridge = new CodexBridge({
    clientInfo: { name: "xcoding-ide", title: "Xcoding IDE", version: app.getVersion() },
    defaultCwd: process.cwd(),
    codexHome: desiredCodexHome,
    codexExecutablePath: resolvedExe.path,
    onEvent: (event) => {
      if (event.kind === "request") {
        codexPendingRequestsById.set(Number(event.id), { method: String(event.method ?? ""), params: event.params });
        broadcast("codex:request", event);
      } else {
        if (event.kind === "status") {
          codexLastStatus = { state: event.status, error: typeof (event as any).error === "string" ? (event as any).error : undefined };
        }
        if (event.kind === "stderr") {
          codexLastStderr = (codexLastStderr + String((event as any).text ?? "")).slice(-16_000);
        }
        broadcast("codex:event", event);
      }
    }
  });
  return codexBridge;
}

type CustomModelsConfig = { baseUrl: string; apiKey?: string };

function parseCodexTomlForCustomModels(configToml: string): { providerId: string | null; baseUrl: string | null } {
  const providerMatch = configToml.match(/^\s*model_provider\s*=\s*"([^"]+)"\s*$/m);
  const providerId = providerMatch ? providerMatch[1] : null;
  if (!providerId) return { providerId: null, baseUrl: null };

  const sectionRe = new RegExp(`^\\s*\\[\\s*model_providers\\.${providerId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\]\\s*$`, "m");
  const sectionStart = configToml.search(sectionRe);
  if (sectionStart < 0) return { providerId, baseUrl: null };

  const after = configToml.slice(sectionStart);
  const nextSectionIdx = after.slice(1).search(/^\s*\[[^\]]+\]\s*$/m);
  const sectionBody = nextSectionIdx >= 0 ? after.slice(0, nextSectionIdx + 1) : after;

  const baseUrlMatch = sectionBody.match(/^\s*base_url\s*=\s*"([^"]+)"\s*$/m);
  const baseUrl = baseUrlMatch ? baseUrlMatch[1] : null;
  return { providerId, baseUrl };
}

function readCodexAuthApiKey(authJson: string): string | null {
  try {
    const parsed = JSON.parse(authJson);
    const key = typeof parsed?.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
    return key && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

async function tryFetchCustomModelList(): Promise<any | null> {
  const codexHome = path.join(homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  let configToml: string;
  try {
    configToml = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const { baseUrl } = parseCodexTomlForCustomModels(configToml);
  if (!baseUrl) return null;

  let apiKey: string | null = null;
  try {
    apiKey = readCodexAuthApiKey(fs.readFileSync(authPath, "utf8"));
  } catch {
    apiKey = null;
  }

  const trimmed = baseUrl.replace(/\/+$/, "");
  const modelsUrl = `${trimmed}/models`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
    if (!raw) return null;

    const data = raw
      .map((m: any) => {
        const id = String(m?.id ?? m?.model ?? m?.slug ?? "").trim();
        if (!id) return null;
        return {
          id,
          model: id,
          displayName: String(m?.display_name ?? m?.displayName ?? id),
          description: String(m?.description ?? ""),
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: false
        };
      })
      .filter(Boolean);

    if (!data.length) return null;
    return { data, next_cursor: null };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function broadcastAiStatus(slot: number, status: "idle" | "running" | "done" | "error") {
  broadcast("ai:status", { slot, status, timestamp: Date.now() });
}

function codexSnapshotKey(threadId: string, turnId: string) {
  return `${threadId}:${turnId}`;
}

function ensureCodexSnapshotsRoot() {
  const root = path.join(app.getPath("userData"), "codex-turn-snapshots");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function safeRelPath(input: string) {
  return String(input ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function extractCodexFileChangePaths(params: any): string[] {
  const p = params ?? {};
  const item = p.item && typeof p.item === "object" ? p.item : null;
  const changes = Array.isArray(item?.changes) ? item.changes : Array.isArray(p.changes) ? p.changes : [];
  const paths = changes
    .map((c: any) => (c && typeof c === "object" ? String(c.path ?? "") : ""))
    .filter(Boolean)
    .map(safeRelPath);
  return Array.from(new Set(paths));
}

function resolveCodexPath(cwd: string, relOrAbs: string) {
  const p = String(relOrAbs ?? "");
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  return path.join(cwd, safeRelPath(p));
}

function snapshotCodexTurnFiles(threadId: string, turnId: string, cwd: string, relPaths: string[]) {
  const key = codexSnapshotKey(threadId, turnId);
  const prev = codexTurnSnapshotsByKey.get(key);
  const snapshot: CodexTurnSnapshot =
    prev ?? ({ threadId, turnId, cwd, createdAt: Date.now(), entries: [] } satisfies CodexTurnSnapshot);

  const root = ensureCodexSnapshotsRoot();
  const snapDir = path.join(root, encodeURIComponent(threadId), encodeURIComponent(turnId));
  fs.mkdirSync(snapDir, { recursive: true });

  for (const rel of relPaths) {
    const abs = resolveCodexPath(cwd, rel);
    if (!abs) continue;
    const resolved = path.resolve(abs);
    const resolvedCwd = path.resolve(cwd);
    if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) continue;
    if (snapshot.entries.some((e) => e.absPath === resolved)) continue;

    const existed = fs.existsSync(resolved);
    const fileName = `${snapshot.entries.length.toString().padStart(4, "0")}.bin`;
    const snapshotFile = path.join(snapDir, fileName);
    try {
      if (existed) {
        const buf = fs.readFileSync(resolved);
        fs.writeFileSync(snapshotFile, buf);
      } else {
        fs.writeFileSync(snapshotFile, Buffer.from(""));
      }
      snapshot.entries.push({ relPath: rel, absPath: resolved, existed, snapshotFile: fileName });
    } catch {
      // ignore snapshot failure; do not block approvals
    }
  }

  if (snapshot.entries.length) {
    codexTurnSnapshotsByKey.set(key, snapshot);
    try {
      fs.writeFileSync(path.join(snapDir, "manifest.json"), JSON.stringify(snapshot, null, 2), "utf8");
    } catch {
      // ignore
    }
  }
}

function revertCodexTurnSnapshot(threadId: string, turnId: string) {
  const key = codexSnapshotKey(threadId, turnId);
  const snapshot = codexTurnSnapshotsByKey.get(key);
  if (!snapshot) return { ok: false as const, reason: "no_snapshot" as const };

  const root = ensureCodexSnapshotsRoot();
  const snapDir = path.join(root, encodeURIComponent(threadId), encodeURIComponent(turnId));
  for (const entry of snapshot.entries) {
    const target = entry.absPath;
    try {
      if (!entry.existed) {
        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
        continue;
      }
      const buf = fs.readFileSync(path.join(snapDir, entry.snapshotFile));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
    } catch {
      // ignore
    }
  }
  return { ok: true as const };
}

function applyCodexTurnSnapshot(threadId: string, turnId: string) {
  const key = codexSnapshotKey(threadId, turnId);
  const snapshot = codexTurnSnapshotsByKey.get(key);
  if (!snapshot) return { ok: false as const, reason: "no_snapshot" as const };
  codexTurnSnapshotsByKey.delete(key);
  try {
    const root = ensureCodexSnapshotsRoot();
    const snapDir = path.join(root, encodeURIComponent(threadId), encodeURIComponent(turnId));
    fs.rmSync(snapDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  return { ok: true as const };
}

function getProjectForSlot(slot: number) {
  const slotEntry = projectsState.slots.find((s) => s.slot === slot);
  if (!slotEntry?.projectId) return null;
  const project = projectsState.projects[slotEntry.projectId];
  if (!project?.path) return null;
  return project;
}

function ensureProjectService(projectId: string, projectPath: string) {
  const existing = projectServices.get(projectId);
  if (existing && existing.child.exitCode === null) return existing;

  const servicePath = path.join(__dirname, "projectService.cjs");
  const child = spawn(process.execPath, [servicePath], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });

  const pending = new Map<string, (res: ProjectServiceResponse) => void>();

  child.on("message", (msg: any) => {
    if (msg && typeof msg === "object" && msg.type === "event") {
      broadcast("project:event", { projectId, ...msg.payload });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as any).id !== "string") return;
    const handler = pending.get((msg as any).id);
    if (!handler) return;
    pending.delete((msg as any).id);
    handler(msg);
  });
  child.on("exit", () => {
    pending.forEach((handler, id) => handler({ id, ok: false, error: "service_exited" }));
    pending.clear();
    projectServices.delete(projectId);
  });

  const entry = { child, pending };
  projectServices.set(projectId, entry);

  void sendToProjectService(projectId, { type: "init", projectPath });
  return entry;
}

async function freezeProjectService(projectId: string) {
  const service = projectServices.get(projectId);
  if (!service) return;
  try {
    await sendToProjectService(projectId, { type: "watcher:stop" });
  } catch {
    // ignore
  }
  try {
    service.child.kill();
  } catch {
    // ignore
  }
  projectServices.delete(projectId);
}

function scheduleFreeze(projectId: string) {
  const existing = freezeTimers.get(projectId);
  if (existing) clearTimeout(existing);
  freezeTimers.set(
    projectId,
    setTimeout(() => {
      freezeTimers.delete(projectId);
      void freezeProjectService(projectId);
    }, BACKGROUND_FREEZE_MS)
  );
}

function sendToProjectService(projectId: string, payload: ProjectServiceRequestNoId): Promise<ProjectServiceResponse> {
  const project = projectsState.projects[projectId];
  if (!project) return Promise.resolve({ id: "unknown", ok: false, error: "project_not_found" });

  const service = ensureProjectService(projectId, project.path);
  const id = `ps-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const message: ProjectServiceRequest = { id, ...(payload as any) };

  return new Promise((resolve) => {
    service.pending.set(id, resolve);
    try {
      service.child.send(message);
    } catch (e) {
      service.pending.delete(id);
      resolve({ id, ok: false, error: e instanceof Error ? e.message : "send_failed" });
    }
  });
}

function ensureAiService() {
  if (aiService && aiService.child.exitCode === null) return aiService;
  const servicePath = path.join(__dirname, "aiService.cjs");
  const child = spawn(process.execPath, [servicePath], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  const pending = new Map<string, (res: any) => void>();
  child.on("message", (msg: any) => {
    if (msg && typeof msg === "object" && msg.type === "event") {
      const requestId = String(msg?.payload?.id ?? "");
      const slot = aiChatSlotByRequestId.get(requestId);
      broadcast("ai:stream", { ...msg.payload, slot: typeof slot === "number" ? slot : undefined });
      if (msg?.payload?.kind === "done" || msg?.payload?.kind === "error") aiChatSlotByRequestId.delete(requestId);
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as any).id !== "string") return;
    const handler = pending.get((msg as any).id);
    if (!handler) return;
    pending.delete((msg as any).id);
    handler(msg);
  });
  child.on("exit", () => {
    pending.forEach((handler, id) => handler({ id, ok: false, error: "service_exited" }));
    pending.clear();
    aiService = null;
  });
  aiService = { child, pending };
  return aiService;
}

function sendToAiService(message: any) {
  const svc = ensureAiService();
  svc.child.send(message);
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
    const service = projectServices.get(projectId);
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
      const t = freezeTimers.get(projectId);
      if (t) clearTimeout(t);
      freezeTimers.delete(projectId);
    } else {
      scheduleFreeze(projectId);
    }
  }
}

function registerShortcuts() {
  for (let i = 1; i <= 8; i += 1) {
    const accelerator = `CommandOrControl+${i}`;
    globalShortcut.register(accelerator, () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win || !windowsById.has(win.id)) return;
      const slots = getVisibleBoundSlotsForWindow(win.id);
      const targetSlot = slots[i - 1];
      if (typeof targetSlot !== "number") return;
      void setActiveSlotForWindow(win.id, targetSlot);
    });
  }
}

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

function setupIpc() {
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:setLanguage", (_event, { language }: { language: AppSettings["ui"]["language"] }) => {
    settings.ui.language = language;
    persistSettingsToDisk();
    setupAppMenu(settings.ui.language);
    return { ok: true };
  });
  ipcMain.handle(
    "settings:setAiConfig",
    (
      _event,
      { apiBase, apiKey, model }: { apiBase: string; apiKey: string; model: string }
    ) => {
      settings.ai.apiBase = apiBase;
      settings.ai.apiKey = apiKey;
      settings.ai.model = model;
      persistSettingsToDisk();
      return { ok: true };
    }
  );
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

  ipcMain.handle("window:minimize", (event) => {
    const win = getWindowFromEvent(event) ?? mainWindow;
    win?.minimize();
    return { ok: true };
  });
  ipcMain.handle("window:maximizeToggle", (event) => {
    const win = getWindowFromEvent(event) ?? mainWindow;
    if (!win) return { ok: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });
  ipcMain.handle("window:close", (event) => {
    const win = getWindowFromEvent(event) ?? mainWindow;
    win?.close();
    return { ok: true };
  });

  ipcMain.handle(
    "ai:chatStart",
    (_event, { slot, requestId, messages }: { slot: number; requestId: string; messages: Array<{ role: string; content: string }> }) => {
      aiChatSlotByRequestId.set(requestId, slot);
      broadcastAiStatus(slot, "running");
      sendToAiService({
        id: requestId,
        type: "chat:start",
        apiBase: settings.ai.apiBase,
        apiKey: settings.ai.apiKey,
        model: settings.ai.model,
        messages
      });
      return { ok: true };
    }
  );

  ipcMain.handle("ai:chatCancel", (_event, { slot, requestId }: { slot: number; requestId: string }) => {
    sendToAiService({ id: requestId, type: "chat:cancel" });
    broadcastAiStatus(slot, "idle");
    return { ok: true };
  });

  ipcMain.handle("codex:ensureStarted", async () => {
    try {
      await ensureCodexBridge().ensureStarted();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_start_failed" };
    }
  });

  ipcMain.handle("codex:getStatus", async () => {
    try {
      return { ok: true, status: codexLastStatus, lastStderr: codexLastStderr, codexHome: codexHomePath };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_status_failed" };
    }
  });

  ipcMain.handle("codex:threadList", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_list_failed" };
    }
  });

  ipcMain.handle("codex:threadStart", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/start", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_start_failed" };
    }
  });

  ipcMain.handle("codex:threadResume", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/resume", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_resume_failed" };
    }
  });

  ipcMain.handle("codex:sessionRead", async (_event, params: any) => {
    try {
      const filePath = String(params?.path ?? "");
      if (!filePath) return { ok: false, reason: "missing_path" };
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) return { ok: false, reason: "not_found" };
      const raw = fs.readFileSync(resolved, "utf8");

      const turns: any[] = [];
      let current: any | null = null;
      const toolByCallId = new Map<string, any>();

      const ensureTurn = () => {
        if (!current) {
          current = { id: `turn-${turns.length + 1}`, items: [], status: "completed", error: null };
          turns.push(current);
        }
        return current;
      };

      const pushUser = (text: string) => {
        current = { id: `turn-${turns.length + 1}`, items: [], status: "completed", error: null };
        turns.push(current);
        current.items.push({ type: "userMessage", id: `item-user-${current.id}`, content: [{ type: "text", text }] });
      };

      const pushReasoning = (text: string) => {
        const t = ensureTurn();
        t.items.push({ type: "reasoning", id: `item-reasoning-${t.id}-${t.items.length + 1}`, summary: [String(text ?? "")], content: [] });
      };

      const pushAgent = (text: string) => {
        const t = ensureTurn();
        t.items.push({ type: "agentMessage", id: `item-agent-${t.id}-${t.items.length + 1}`, text: String(text ?? "") });
      };

      const upsertTool = (callId: string, patch: (item: any) => void) => {
        const t = ensureTurn();
        let item = toolByCallId.get(callId);
        if (!item) {
          item = { type: "localToolCall", id: callId, name: "", arguments: "", input: "", output: "", status: "completed" };
          toolByCallId.set(callId, item);
          t.items.push(item);
        }
        patch(item);
      };

      const normalizeToolItemType = (item: any) => {
        const name = String(item?.name ?? "");
        if (name === "shell_command") {
          item.type = "commandExecution";
          try {
            const args = JSON.parse(String(item.arguments ?? "{}"));
            if (args && typeof args === "object" && typeof args.command === "string") item.command = args.command;
          } catch {
            // ignore
          }
          if (typeof item.output === "string") item.aggregatedOutput = item.output;
        } else if (name === "apply_patch") {
          item.type = "fileChange";
          const patchText = String(item.input ?? "");
          if (patchText) {
            const paths: string[] = [];
            for (const line of patchText.split(/\r?\n/)) {
              const m = line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
              if (m && m[2]) paths.push(m[2]);
            }
            item.changes = paths.length ? paths.map((p) => ({ path: p, kind: "patch", diff: patchText })) : [{ path: "patch", kind: "patch", diff: patchText }];
          }
        }
      };

      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const type = String(obj?.type ?? "");
        const payload = obj?.payload ?? null;

        if (type === "event_msg" && payload && typeof payload === "object") {
          const msgType = String(payload.type ?? "");
          if (msgType === "user_message") pushUser(String(payload.message ?? ""));
          else if (msgType === "agent_message") pushAgent(String(payload.message ?? ""));
          else if (msgType === "agent_reasoning") pushReasoning(String(payload.text ?? ""));
          continue;
        }

        if (type === "response_item" && payload && typeof payload === "object") {
          const pType = String(payload.type ?? "");
          if (pType === "function_call") {
            const callId = String(payload.call_id ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.name = String(payload.name ?? it.name ?? "");
              it.arguments = String(payload.arguments ?? it.arguments ?? "");
              it.status = "completed";
              normalizeToolItemType(it);
            });
          } else if (pType === "function_call_output") {
            const callId = String(payload.call_id ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.output = String(payload.output ?? it.output ?? "");
              it.status = "completed";
              normalizeToolItemType(it);
            });
          } else if (pType === "custom_tool_call") {
            const callId = String(payload.call_id ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.name = String(payload.name ?? it.name ?? "");
              it.input = String(payload.input ?? it.input ?? "");
              it.status = String(payload.status ?? it.status ?? "completed");
              normalizeToolItemType(it);
            });
          } else if (pType === "custom_tool_call_output") {
            const callId = String(payload.call_id ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.output = String(payload.output ?? it.output ?? "");
              it.status = "completed";
              normalizeToolItemType(it);
            });
          } else if (pType === "reasoning") {
            const content = Array.isArray(payload.content) ? payload.content : [];
            const txt = content.map((c: any) => (c && typeof c === "object" ? String(c.text ?? "") : "")).join("");
            if (txt) pushReasoning(txt);
          }
          continue;
        }
      }

      return { ok: true, result: { turns } };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "session_read_failed" };
    }
  });

  ipcMain.handle("codex:writeImageAttachment", async (_event, params: any) => {
    try {
      const mime = typeof params?.mime === "string" && params.mime.startsWith("image/") ? params.mime : "image/png";
      const bytes = params?.bytes;
      if (!(bytes instanceof ArrayBuffer)) return { ok: false, reason: "missing_bytes" };
      const buf = Buffer.from(new Uint8Array(bytes));
      if (!buf.length) return { ok: false, reason: "empty_bytes" };

      const dir = path.join(app.getPath("userData"), "codex-attachments");
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // ignore
      }

      // Best-effort cleanup: delete files older than 30 days.
      try {
        const entries = fs.readdirSync(dir);
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const name of entries) {
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            if (st.mtimeMs < cutoff) fs.unlinkSync(full);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }

      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
      const suggested = typeof params?.suggestedName === "string" ? params.suggestedName : "";
      const baseName = suggested.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
      const safeStem = baseName ? baseName.replace(/\.[a-zA-Z0-9]+$/, "") : "clipboard";
      const fileName = `${safeStem}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, buf);

      return { ok: true, result: { path: filePath, byteLength: buf.length, mime } };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "write_image_attachment_failed" };
    }
  });

  ipcMain.handle("codex:readLocalImageAsDataUrl", async (_event, params: any) => {
    try {
      const filePath = typeof params?.path === "string" ? params.path : "";
      if (!filePath) return { ok: false, reason: "missing_path" };

      const MAX_BYTES = 10 * 1024 * 1024;
      const st = fs.statSync(filePath);
      if (!st.isFile()) return { ok: false, reason: "not_a_file" };
      if (st.size <= 0) return { ok: false, reason: "empty_file" };
      if (st.size > MAX_BYTES) return { ok: false, reason: "file_too_large" };

      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".bmp"
                ? "image/bmp"
                : ext === ".svg"
                  ? "image/svg+xml"
                  : "image/png";

      const buf = fs.readFileSync(filePath);
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      return { ok: true, result: { dataUrl, mime, byteLength: buf.length } };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "read_local_image_failed" };
    }
  });

  ipcMain.handle("codex:threadArchive", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/archive", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_archive_failed" };
    }
  });

  ipcMain.handle("codex:turnStart", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("turn/start", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_turn_start_failed" };
    }
  });

  ipcMain.handle("codex:turnInterrupt", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("turn/interrupt", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_turn_interrupt_failed" };
    }
  });

  ipcMain.handle("codex:reviewStart", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("review/start", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_review_start_failed" };
    }
  });

	  ipcMain.handle("codex:modelList", async (_event, params: any) => {
	    try {
	      const custom = await tryFetchCustomModelList();
	      if (custom) return { ok: true, result: custom };
	      const result = await ensureCodexBridge().request("model/list", params ?? {});
	      return { ok: true, result };
	    } catch (e) {
	      return { ok: false, reason: e instanceof Error ? e.message : "codex_model_list_failed" };
	    }
	  });

  ipcMain.handle("codex:skillsList", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("skills/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_skills_list_failed" };
    }
  });

  ipcMain.handle("codex:mcpServerStatusList", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("mcpServerStatus/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_mcp_server_status_list_failed" };
    }
  });

  ipcMain.handle("codex:configRead", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("config/read", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_config_read_failed" };
    }
  });

  ipcMain.handle("codex:configValueWrite", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("config/value/write", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_config_write_failed" };
    }
  });

  ipcMain.handle("codex:restart", async () => {
    try {
      // Restart the app-server process so config changes (e.g. MCP enabled flags) take effect.
      if (codexBridge) codexBridge.dispose();
      codexBridge = null;
      codexHomePath = null;
      await ensureCodexBridge().ensureStarted();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_restart_failed" };
    }
  });

  ipcMain.handle("codex:turnRevert", async (_event, { threadId, turnId }: { threadId: string; turnId: string }) => {
    if (!threadId || !turnId) return { ok: false, reason: "missing_ids" };
    return revertCodexTurnSnapshot(String(threadId), String(turnId));
  });

  ipcMain.handle("codex:turnApply", async (_event, { threadId, turnId }: { threadId: string; turnId: string }) => {
    if (!threadId || !turnId) return { ok: false, reason: "missing_ids" };
    return applyCodexTurnSnapshot(String(threadId), String(turnId));
  });

  ipcMain.handle("codex:respond", async (_event, { id, result, error }: { id: number; result?: any; error?: any }) => {
    try {
      const reqId = Number(id);
      const pending = codexPendingRequestsById.get(reqId);
      if (pending && pending.method === "item/fileChange/requestApproval") {
        const decision = result?.decision;
        if (decision === "accept" || decision === "acceptForSession") {
          const params = pending.params ?? {};
          const threadId = String(params?.threadId ?? params?.thread_id ?? "");
          const turnId = String(params?.turnId ?? params?.turn_id ?? "");
          const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
          if (threadId && turnId) {
            const relPaths = extractCodexFileChangePaths(params);
            snapshotCodexTurnFiles(threadId, turnId, cwd, relPaths);
          }
        }
      }
      codexPendingRequestsById.delete(reqId);
      ensureCodexBridge().respond(Number(id), result, error);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_respond_failed" };
    }
  });

  function setSlotPathInternal(slot: number, projectPath: string, windowId?: number) {
    if (slot < 1 || slot > 8) return { ok: false, reason: "invalid_slot" as const };
    const normalized = projectPath.trim();
    if (!normalized) return { ok: false, reason: "empty_path" as const };
    if (!fs.existsSync(normalized)) return { ok: false, reason: "path_not_found" as const };
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) return { ok: false, reason: "not_directory" as const };

    const name = path.basename(normalized);
    const id = `proj-${Buffer.from(normalized).toString("base64url")}`;
    const prev = projectsState.projects[id] ?? ({} as any);
    projectsState.projects[id] = { ...prev, id, path: normalized, name, lastOpenedAt: Date.now() };
    projectsState.slots = projectsState.slots.map((s) => (s.slot === slot ? { slot, projectId: id } : s));
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });

    // If user binds the currently active slot for this window, ensure the service is ready immediately,
    // otherwise the first file open may race before Project Service init.
    const resolvedWindowId = typeof windowId === "number" ? windowId : mainWindow?.id;
    const activeSlotForWindow =
      typeof resolvedWindowId === "number" ? activeSlotByWindowId.get(resolvedWindowId) ?? 1 : 1;
    if (slot === activeSlotForWindow) {
      try {
        ensureProjectService(id, normalized);
        void sendToProjectService(id, { type: "watcher:start" });
        void sendToProjectService(id, { type: "watcher:setPaused", paused: false });
      } catch {
        // ignore
      }
    }
    return { ok: true, projectId: id };
  }

  ipcMain.handle("projects:get", () => ({ ok: true, state: projectsState }));
  ipcMain.handle("projects:setSlotPath", (event, { slot, path: projectPath }: { slot: number; path: string }) =>
    setSlotPathInternal(slot, projectPath, getWindowFromEvent(event)?.id)
  );
  ipcMain.handle("projects:bindCwd", (event, { slot }: { slot: number }) =>
    setSlotPathInternal(slot, process.cwd(), getWindowFromEvent(event)?.id)
  );
  ipcMain.handle("projects:openFolder", async (event, { slot }: { slot: number }) => {
    const win = getWindowFromEvent(event);
    if (!win) return { ok: false, reason: "no_window" };
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true };
    return setSlotPathInternal(slot, res.filePaths[0], win.id);
  });
  ipcMain.handle("projects:setActiveSlot", async (event, { slot }: { slot: number }) => {
    if (typeof slot !== "number" || slot < 1 || slot > 8) return { ok: false, reason: "invalid_slot" as const };
    const win = getWindowFromEvent(event);
    const windowId = win?.id;
    if (typeof windowId === "number") await setActiveSlotForWindow(windowId, slot);
    return { ok: true };
  });

  ipcMain.handle("window:getDetachedSlots", () => ({ ok: true, slots: listDetachedSlots() }));

  ipcMain.handle("window:new", async (_event, { slot, mode }: { slot?: number; mode?: "single" | "multi" }) => {
    const desiredSlot = typeof slot === "number" && slot >= 1 && slot <= 8 ? slot : 1;
    const desiredMode = mode === "single" || mode === "multi" ? mode : "multi";

    if (desiredMode === "single") {
      const existing = findSingleWindowForSlot(desiredSlot);
      if (existing) {
        focusWindow(existing);
        void setActiveSlotForWindow(existing.id, desiredSlot);
        return { ok: true, windowId: existing.id, reused: true };
      }
    }

    const win = createWindow();
    activeSlotByWindowId.set(win.id, desiredSlot);
    if (desiredMode === "single") singleSlotByWindowId.set(win.id, desiredSlot);
    else singleSlotByWindowId.delete(win.id);
    broadcastDetachedSlots();
    try {
      // Reload URL with desired slot (works for both dev and packaged).
      const qs = `?slot=${desiredSlot}&windowMode=${desiredMode}`;
      if (!app.isPackaged) await win.loadURL(`${DEV_SERVER_URL}${qs}`);
      else await win.loadFile(path.join(__dirname, "../index.html"), { search: qs });
    } catch {
      if (desiredMode === "single") {
        singleSlotByWindowId.delete(win.id);
        broadcastDetachedSlots();
      }
    }
    return { ok: true, windowId: win.id };
  });

  ipcMain.handle("projects:unbindSlot", async (_event, { slot }: { slot: number }) => {
    if (typeof slot !== "number" || slot < 1 || slot > 8) return { ok: false, reason: "invalid_slot" as const };
    const previousProjectId = projectsState.slots.find((s) => s.slot === slot)?.projectId;
    projectsState.slots = projectsState.slots.map((s) => (s.slot === slot ? { slot, projectId: undefined } : s));
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });

    aiStagingBySlot.delete(slot);
    broadcastAiStatus(slot, "idle");

    if (previousProjectId) {
      try {
        await sendToProjectService(previousProjectId, { type: "watcher:setPaused", paused: true });
        scheduleFreeze(previousProjectId);
      } catch {
        // ignore
      }
    }
    return { ok: true };
  });

  ipcMain.handle("projects:reorderSlots", (_event, { slotOrder }: { slotOrder: number[] }) => {
    if (!Array.isArray(slotOrder) || slotOrder.length !== 8) return { ok: false, reason: "invalid_slot_order" as const };
    const normalized = Array.from(new Set(slotOrder)).filter((n) => typeof n === "number" && n >= 1 && n <= 8);
    if (normalized.length !== 8) return { ok: false, reason: "invalid_slot_order" as const };
    projectsState.slotOrder = normalized;
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });
    return { ok: true };
  });

  ipcMain.handle("projects:setUiLayout", (_event, { projectId, layout }: { projectId: string; layout: UiLayout }) => {
    const project = projectsState.projects[projectId];
    if (!project) return { ok: false, reason: "project_not_found" as const };
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
    const next: UiLayout = {
      explorerWidth: clamp(Number(layout?.explorerWidth) || 180, 180, 520),
      chatWidth: clamp(Number(layout?.chatWidth) || 530, 220, 640),
      isExplorerVisible: Boolean(layout?.isExplorerVisible),
      isChatVisible: Boolean(layout?.isChatVisible)
    };
    projectsState.projects[projectId] = { ...project, uiLayout: next };
    persistProjectsToDisk();
    broadcast("projects:state", { state: projectsState });
    return { ok: true };
  });

  ipcMain.handle("projects:getWorkflow", (_event, { projectId }: { projectId: string }) => {
    const project = projectsState.projects[projectId];
    if (!project) return { ok: false, reason: "project_not_found" as const };
    const stage = project.workflow?.stage;
    const workflow =
      stage === "idea" || stage === "auto" || stage === "preview" || stage === "develop"
        ? project.workflow
        : { stage: "develop" as const, lastUpdatedAt: Date.now() };
    return { ok: true, workflow };
  });

  ipcMain.handle(
    "projects:setWorkflow",
    (_event, { projectId, workflow }: { projectId: string; workflow: Partial<ProjectWorkflow> }) => {
      const project = projectsState.projects[projectId];
      if (!project) return { ok: false, reason: "project_not_found" as const };
      const stage = String((workflow as any)?.stage ?? "");
      if (stage !== "idea" && stage !== "auto" && stage !== "preview" && stage !== "develop") {
        return { ok: false, reason: "invalid_stage" as const };
      }

      const prev = project.workflow ?? { stage: "develop" as const };
      const next: ProjectWorkflow = { ...prev, ...workflow, stage: stage as WorkflowStage, lastUpdatedAt: Date.now() };
      projectsState.projects[projectId] = { ...project, workflow: next };
      persistProjectsToDisk();
      broadcast("projects:state", { state: projectsState });
      return { ok: true };
    }
  );

  ipcMain.handle("project:fsReadFile", async (_event, { slot, path: relPath }: { slot: number; path: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:readFile", relPath });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, content: String((res.result as any)?.content ?? "") };
  });

  ipcMain.handle(
    "project:fsWriteFile",
    async (_event, { slot, path: relPath, content }: { slot: number; path: string; content: string }) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, { type: "fs:writeFile", relPath, content });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true };
    }
  );

  ipcMain.handle("project:fsListDir", async (_event, { slot, dir }: { slot: number; dir: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:listDir", relDir: dir });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, entries: (res.result as any)?.entries ?? [] };
  });

  ipcMain.handle("project:searchPaths", async (_event, { slot, query, limit }: { slot: number; query: string; limit?: number }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:searchPaths", query, limit });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, results: (res.result as any)?.results ?? [] };
  });

  ipcMain.handle("project:gitStatus", async (_event, { slot, maxEntries }: { slot: number; maxEntries?: number }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:gitStatus", maxEntries });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, entries: (res.result as any)?.entries ?? {} };
  });

  ipcMain.handle(
    "project:searchFiles",
    async (_event, { slot, query, maxResults, useGitignore }: { slot: number; query: string; maxResults?: number; useGitignore?: boolean }) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, { type: "fs:searchFiles", query, maxResults, useGitignore });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true, results: (res.result as any)?.results ?? [] };
    }
  );

  ipcMain.handle(
    "project:searchContent",
    async (
      _event,
      {
        slot,
        query,
        maxResults,
        caseSensitive,
        wholeWord,
        regex,
        filePattern,
        include,
        exclude,
        useGitignore
      }: {
        slot: number;
        query: string;
        maxResults?: number;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        regex?: boolean;
        filePattern?: string;
        include?: string[];
        exclude?: string[];
        useGitignore?: boolean;
      }
    ) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, {
        type: "fs:searchContent",
        query,
        maxResults,
        caseSensitive,
        wholeWord,
        regex,
        filePattern,
        include,
        exclude,
        useGitignore
      });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true, result: res.result };
    }
  );

  ipcMain.handle(
    "project:replaceContent",
    async (
      _event,
      {
        slot,
        query,
        replace,
        caseSensitive,
        wholeWord,
        regex,
        filePattern,
        include,
        exclude,
        useGitignore,
        maxFiles,
        maxMatches,
        maxFileSize
      }: {
        slot: number;
        query: string;
        replace: string;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        regex?: boolean;
        filePattern?: string;
        include?: string[];
        exclude?: string[];
        useGitignore?: boolean;
        maxFiles?: number;
        maxMatches?: number;
        maxFileSize?: string;
      }
    ) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, {
        type: "fs:replaceContent",
        query,
        replace,
        caseSensitive,
        wholeWord,
        regex,
        filePattern,
        include,
        exclude,
        useGitignore,
        maxFiles,
        maxMatches,
        maxFileSize
      });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true, result: res.result };
    }
  );

  ipcMain.handle("project:fsDeleteFile", async (_event, { slot, path: rel }: { slot: number; path: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    if (!app.isPackaged) console.log("[project:fsDeleteFile]", { slot, rel });
    const res = await sendToProjectService(project.id, { type: "fs:deleteFile", relPath: rel });
    if (!app.isPackaged) console.log("[project:fsDeleteFile:res]", res);
    if (!res.ok) return { ok: false, reason: res.error };
    const stat = await sendToProjectService(project.id, { type: "fs:stat", relPath: rel });
    if (!app.isPackaged) console.log("[project:fsDeleteFile:stat]", stat);
    if (stat.ok && (stat.result as any)?.exists) return { ok: false, reason: "delete_failed_file_still_exists" };
    return { ok: true };
  });

  ipcMain.handle("project:fsMkdir", async (_event, { slot, dir }: { slot: number; dir: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:mkdir", relDir: dir });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true };
  });

  ipcMain.handle("project:fsRename", async (_event, { slot, from, to }: { slot: number; from: string; to: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:rename", from, to });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true };
  });

  ipcMain.handle("project:fsDeleteDir", async (_event, { slot, dir }: { slot: number; dir: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:deleteDir", relDir: dir });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true };
  });

  ipcMain.handle("project:tsDiagnostics", async (_event, { slot, path: relPath, content }: { slot: number; path: string; content: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "lang:ts:diagnostics", relPath, content });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, diagnostics: (res.result as any)?.diagnostics ?? [] };
  });

  ipcMain.handle(
    "project:lspDidOpen",
    async (
      _event,
      { slot, language, path: relPath, languageId, content }: { slot: number; language: "python" | "go"; path: string; languageId: string; content: string }
    ) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, { type: "lsp:didOpen", language, relPath, languageId, content });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true };
    }
  );

  ipcMain.handle(
    "project:lspDidChange",
    async (_event, { slot, language, path: relPath, content }: { slot: number; language: "python" | "go"; path: string; content: string }) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, { type: "lsp:didChange", language, relPath, content });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true };
    }
  );

  ipcMain.handle(
    "project:lspDidClose",
    async (_event, { slot, language, path: relPath }: { slot: number; language: "python" | "go"; path: string }) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, { type: "lsp:didClose", language, relPath });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true };
    }
  );

  ipcMain.handle(
    "project:lspRequest",
    async (
      _event,
      { slot, language, method, path: relPath, params }: { slot: number; language: "python" | "go"; method: string; path: string; params?: unknown }
    ) => {
      const project = getProjectForSlot(slot);
      if (!project) return { ok: false, reason: "project_unbound" };
      const res = await sendToProjectService(project.id, { type: "lsp:request", language, method, relPath, params });
      if (!res.ok) return { ok: false, reason: res.error };
      return { ok: true, result: res.result };
    }
  );

  ipcMain.handle(
    "ai:stageEdits",
    (_event, { slot, fileEdits }: { slot: number; fileEdits: Array<{ path: string; content: string }> }) => {
      const patchId = `patch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const entry: AiStaging = { patchId, fileEdits, createdAt: Date.now() };
      const list = aiStagingBySlot.get(slot) ?? [];
      list.push(entry);
      aiStagingBySlot.set(slot, list.slice(-20));
      return { ok: true, patchId };
    }
  );

  ipcMain.handle("ai:getStaging", (_event, { slot }: { slot: number }) => {
    const list = aiStagingBySlot.get(slot) ?? [];
    return {
      ok: true,
      staging: list.map((p) => ({
        patchId: p.patchId,
        fileEdits: p.fileEdits.map((e) => ({ path: e.path })),
        createdAt: p.createdAt,
        appliedAt: p.appliedAt,
        revertedAt: p.revertedAt
      }))
    };
  });

  ipcMain.handle("ai:applyAll", async (_event, { slot }: { slot: number }) => {
    const list = aiStagingBySlot.get(slot) ?? [];
    const now = Date.now();
    const patch = [...list].reverse().find((e) => !e.appliedAt && !e.revertedAt);
    if (!patch) return { ok: true, appliedFiles: [] };
    const snapshot: AiStaging["snapshot"] = [];
    const appliedFiles: string[] = [];
    try {
      for (const edit of patch.fileEdits) {
        const safeRel = edit.path.replace(/^([/\\\\])+/, "");
        const project = getProjectForSlot(slot);
        if (!project) throw new Error("project_unbound");
        const statRes = await sendToProjectService(project.id, { type: "fs:stat", relPath: safeRel });
        if (!statRes.ok) throw new Error(statRes.error);
        const exists = Boolean((statRes.result as any)?.exists);
        let prev: string | undefined;
        if (exists) {
          const readRes = await sendToProjectService(project.id, { type: "fs:readFile", relPath: safeRel });
          if (!readRes.ok) throw new Error(readRes.error);
          prev = String((readRes.result as any)?.content ?? "");
        }
        snapshot.push({ path: safeRel, existed: exists, content: prev });

        const writeRes = await sendToProjectService(project.id, { type: "fs:writeFile", relPath: safeRel, content: edit.content });
        if (!writeRes.ok) throw new Error(writeRes.error);
        appliedFiles.push(safeRel);
      }
      patch.snapshot = snapshot;
      patch.appliedAt = now;
      aiStagingBySlot.set(slot, list);
      broadcastAiStatus(slot, "done");
      return { ok: true, appliedFiles: Array.from(new Set(appliedFiles)) };
    } catch (e) {
      broadcastAiStatus(slot, "error");
      return { ok: false, reason: e instanceof Error ? e.message : "apply_failed" };
    }
  });

  ipcMain.handle("ai:revertLast", async (_event, { slot }: { slot: number }) => {
    const list = aiStagingBySlot.get(slot) ?? [];
    const lastApplied = [...list].reverse().find((e) => e.appliedAt && !e.revertedAt);
    if (!lastApplied) return { ok: true, revertedFiles: [] };
    if (!lastApplied.snapshot) return { ok: false, reason: "no_snapshot" };
    const revertedFiles: string[] = [];
    try {
      const project = getProjectForSlot(slot);
      if (!project) throw new Error("project_unbound");
      for (const snap of lastApplied.snapshot) {
        if (!snap.existed) {
          const delRes = await sendToProjectService(project.id, { type: "fs:deleteFile", relPath: snap.path });
          if (!delRes.ok) throw new Error(delRes.error);
          revertedFiles.push(snap.path);
          continue;
        }
        const writeRes = await sendToProjectService(project.id, {
          type: "fs:writeFile",
          relPath: snap.path,
          content: snap.content ?? ""
        });
        if (!writeRes.ok) throw new Error(writeRes.error);
        revertedFiles.push(snap.path);
      }
      lastApplied.revertedAt = Date.now();
      aiStagingBySlot.set(slot, list);
      return { ok: true, revertedFiles: Array.from(new Set(revertedFiles)) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "revert_failed" };
    }
  });

  ipcMain.handle("fs:readFile", async (_event, { slot, path: rel }: { slot: number; path: string }) => {
    const project = getProjectForSlot(slot);
    if (!project) return { ok: false, reason: "project_unbound" };
    const res = await sendToProjectService(project.id, { type: "fs:readFile", relPath: rel });
    if (!res.ok) return { ok: false, reason: res.error };
    return { ok: true, content: String((res.result as any)?.content ?? "") };
  });

  ipcMain.handle("terminal:create", (_event, { slot }: { slot?: number } = {}) => {
    const id = `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requestedCwd =
      typeof slot === "number"
        ? getProjectForSlot(slot)?.path ?? process.cwd()
        : process.cwd();
    const cwd = fs.existsSync(requestedCwd) ? requestedCwd : process.cwd();

    try {
      let lastError: unknown = null;
      const env = sanitizeShellEnv({
        ...process.env,
        PATH: getEnhancedPath(),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8"
      });

      const candidates = findLoginShellForPty().map((c) => ({ file: c.shell, args: c.args, label: c.label }));
      for (const c of candidates) {
        try {
          const ptyProcess = pty.spawn(c.file, c.args, {
            name: "xterm-256color",
            cols: 120,
            rows: 30,
            cwd,
            env
          });
          terminalSessions.set(id, { id, kind: "pty", pty: ptyProcess, buffer: "" });
          ptyProcess.onData((data) => {
            appendTerminalBuffer(id, data);
            broadcast("terminal:data", { sessionId: id, data });
          });
          ptyProcess.onExit(() => terminalSessions.delete(id));
          return { ok: true, sessionId: id, cwd, shell: c.label, kind: "pty" as const };
        } catch (e) {
          lastError = e;
        }
      }

      // Fallback: non-PTY process-based terminal (limited interactivity but works when pty is unavailable).
      const fallbackShell =
        process.platform === "win32" ? "powershell.exe" : (process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
      const proc = spawn(fallbackShell, [], {
        cwd,
        env: sanitizeShellEnv({
          ...process.env,
          PATH: getEnhancedPath(),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: process.env.LANG || "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8"
        }),
        stdio: "pipe"
      });
      terminalSessions.set(id, { id, kind: "proc", proc, buffer: "" });
      proc.stdout.on("data", (buf) => {
        const data = buf.toString("utf8");
        appendTerminalBuffer(id, data);
        broadcast("terminal:data", { sessionId: id, data });
      });
      proc.stderr.on("data", (buf) => {
        const data = buf.toString("utf8");
        appendTerminalBuffer(id, data);
        broadcast("terminal:data", { sessionId: id, data });
      });
      proc.on("exit", () => terminalSessions.delete(id));
      return { ok: true, sessionId: id, cwd, shell: `proc:${fallbackShell}`, kind: "proc" as const, lastError: String((lastError as any)?.message ?? lastError ?? "") };
    } catch (e) {
      const err = e as any;
      const extra = typeof err?.errno === "number" ? ` (errno=${err.errno})` : "";
      const message = e instanceof Error ? e.message : "spawn_failed";
      return { ok: false, reason: `${message}${extra}`, cwd };
    }
  });

  ipcMain.handle("terminal:write", (_event, { sessionId, data }: { sessionId: string; data: string }) => {
    const s = terminalSessions.get(sessionId);
    if (!s) return { ok: false };
    if (s.kind === "pty" && s.pty) s.pty.write(data);
    if (s.kind === "proc" && s.proc) s.proc.stdin.write(data);
    return { ok: true };
  });

  ipcMain.handle("terminal:resize", (_event, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
    const s = terminalSessions.get(sessionId);
    if (!s) return { ok: false };
    if (s.kind === "pty" && s.pty) s.pty.resize(cols, rows);
    return { ok: true };
  });

  ipcMain.handle("terminal:getBuffer", (_event, { sessionId, maxBytes }: { sessionId: string; maxBytes?: number }) => {
    const s = terminalSessions.get(sessionId);
    if (!s) return { ok: false };
    const buf = s.buffer ?? "";
    const max = typeof maxBytes === "number" ? Math.max(1_000, Math.min(500_000, maxBytes)) : 200_000;
    const out = buf.length > max ? buf.slice(buf.length - max) : buf;
    return { ok: true, data: out };
  });

  ipcMain.handle("terminal:dispose", (_event, { sessionId }: { sessionId: string }) => {
    const s = terminalSessions.get(sessionId);
    if (!s) return { ok: true };
    try {
      if (s.kind === "pty" && s.pty) s.pty.kill();
      if (s.kind === "proc" && s.proc) s.proc.kill();
    } catch {
      // ignore
    } finally {
      terminalSessions.delete(sessionId);
    }
    return { ok: true };
  });

  ipcMain.handle("os:copyText", (_event, { text }: { text: string }) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "copy_failed" };
    }
  });

  ipcMain.handle("preview:create", (_event, { previewId, url }: { previewId: string; url: string }) => {
    if (!mainWindow) return { ok: false, reason: "no_window" };
    if (previews.has(previewId)) return { ok: true };

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
    return { ok: true };
  });

  ipcMain.handle(
    "preview:show",
    (_event, { previewId, bounds }: { previewId: string; bounds: { x: number; y: number; width: number; height: number } }) => {
      if (!mainWindow) return { ok: false, reason: "no_window" };
      const entry = previews.get(previewId);
      if (!entry) return { ok: false, reason: "not_found" };

      if (activePreviewId && activePreviewId !== previewId) {
        const prev = previews.get(activePreviewId);
        if (prev) mainWindow.removeBrowserView(prev.view);
      }
      activePreviewId = previewId;

      mainWindow.addBrowserView(entry.view);
      entry.view.setBounds(bounds);
      entry.view.setAutoResize({ width: false, height: false });
      return { ok: true };
    }
  );

  ipcMain.handle("preview:hide", (_event, { previewId }: { previewId: string }) => {
    if (!mainWindow) return { ok: true };
    if (!activePreviewId || activePreviewId !== previewId) return { ok: true };
    const entry = previews.get(previewId);
    if (entry) mainWindow.removeBrowserView(entry.view);
    activePreviewId = null;
    return { ok: true };
  });

  ipcMain.handle("preview:setBounds", (_event, { previewId, bounds }: { previewId: string; bounds: { x: number; y: number; width: number; height: number } }) => {
    const entry = previews.get(previewId);
    if (!entry) return { ok: false, reason: "not_found" };
    entry.view.setBounds(bounds);
    return { ok: true };
  });

  ipcMain.handle("preview:navigate", (_event, { previewId, url }: { previewId: string; url: string }) => {
    const entry = previews.get(previewId);
    if (!entry) return { ok: false, reason: "not_found" };
    entry.url = url;
    void entry.view.webContents.loadURL(url);
    return { ok: true };
  });

  ipcMain.handle("preview:destroy", (_event, { previewId }: { previewId: string }) => {
    const entry = previews.get(previewId);
    if (!entry) return { ok: true };
    if (mainWindow) mainWindow.removeBrowserView(entry.view);
    try {
      entry.view.webContents.debugger.detach();
    } catch {
      // ignore
    }
    entry.view.webContents.close();
    previews.delete(previewId);
    if (activePreviewId === previewId) activePreviewId = null;
    return { ok: true };
  });
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
  createWindow();
  setupAppMenu(settings.ui.language);
  setupIpc();
  registerShortcuts();
  for (let slot = 1; slot <= 8; slot += 1) broadcastAiStatus(slot, "idle");
  broadcast("projects:state", { state: projectsState });
  broadcastDetachedSlots();

  if (settings.ai.codex.prewarm) {
    void ensureCodexBridge()
      .ensureStarted()
      .catch(() => void 0);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  for (const session of terminalSessions.values()) {
    try {
      if (session.kind === "pty" && session.pty) session.pty.kill();
      if (session.kind === "proc" && session.proc) session.proc.kill();
    } catch {
      // ignore
    }
  }

  try {
    codexBridge?.dispose();
  } catch {
    // ignore
  }
  codexBridge = null;
  codexHomePath = null;
});
