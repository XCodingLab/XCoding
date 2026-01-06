import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { UiLayout } from "./settingsStore";

export type ProjectRecord = {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number;
  uiLayout?: UiLayout;
  workflow?: ProjectWorkflow;
};

export type WorkflowStage = "idea" | "auto" | "preview" | "develop";

export type ProjectWorkflow = { stage: WorkflowStage; lastUpdatedAt?: number };

export type ProjectsState = {
  schemaVersion: 3;
  slotOrder: number[];
  slots: Array<{ slot: number; projectId?: string }>;
  projects: Record<string, ProjectRecord>;
};

export let projectsState: ProjectsState = {
  schemaVersion: 3,
  slotOrder: Array.from({ length: 8 }).map((_, i) => i + 1),
  slots: Array.from({ length: 8 }).map((_, i) => ({ slot: i + 1 })),
  projects: {}
};

export function projectsPath() {
  return path.join(app.getPath("userData"), "projects.json");
}

function migrateProjectLayoutDefaults() {
  let migrated = false;
  for (const project of Object.values(projectsState.projects)) {
    const l = project.uiLayout;
    if (!l) continue;
    if (l.explorerWidth !== 266 || l.chatWidth !== 324 || l.isExplorerVisible !== true || l.isChatVisible !== true) continue;
    project.uiLayout = { ...l, explorerWidth: 180 };
    migrated = true;
  }
  return migrated;
}

function migrateProjectWorkflowDefaults() {
  let migrated = false;
  for (const project of Object.values(projectsState.projects)) {
    const stage = project.workflow?.stage;
    if (stage === "idea" || stage === "auto" || stage === "preview" || stage === "develop") continue;
    project.workflow = { stage: "develop", lastUpdatedAt: Date.now() };
    migrated = true;
  }
  return migrated;
}

export function loadProjectsFromDisk() {
  try {
    const raw = fs.readFileSync(projectsPath(), "utf8");
    const parsed = JSON.parse(raw) as { schemaVersion?: number; slots?: unknown; projects?: unknown; slotOrder?: unknown };

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

export function persistProjectsToDisk() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(projectsPath(), JSON.stringify(projectsState, null, 2), "utf8");
  } catch {
    // ignore
  }
}

export function getProjectForSlot(slot: number) {
  const slotEntry = projectsState.slots.find((s) => s.slot === slot);
  if (!slotEntry?.projectId) return null;
  const project = projectsState.projects[slotEntry.projectId];
  if (!project?.path) return null;
  return project;
}
