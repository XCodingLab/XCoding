import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { EOL } from "node:os";
import path from "node:path";
import type { ProjectServiceRequest, ProjectServiceRequestNoId, ProjectServiceResponse } from "../shared/projectServiceProtocol";
import { broadcast } from "../app/windowManager";
import { projectsState } from "../stores/projectsStore";
import { resolveRunAsNodeExecutablePath } from "../shared/runAsNodeExecutable";

export type ProjectServiceEntry = {
  child: ChildProcess;
  pending: Map<string, (res: ProjectServiceResponse) => void>;
};

const projectServices = new Map<string, ProjectServiceEntry>();
const freezeTimers = new Map<string, NodeJS.Timeout>();
const BACKGROUND_FREEZE_MS = 60_000;

export function getProjectServiceEntry(projectId: string) {
  return projectServices.get(projectId) ?? null;
}

export function ensureProjectService(projectId: string, projectPath: string) {
  const existing = projectServices.get(projectId);
  if (existing && existing.child.exitCode === null) return existing;

  const servicePath = path.join(__dirname, "projectService.cjs");
  const child = spawn(resolveRunAsNodeExecutablePath(), [servicePath], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });

  const shouldLogService = app.isPackaged || process.env.XCODING_SERVICE_LOG === "1" || process.argv.includes("--service-log");

  let serviceLogStream: fs.WriteStream | null = null;
  if (shouldLogService) {
    try {
      const logDir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const safeProjectId = projectId.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const logFile = path.join(logDir, `projectService-${safeProjectId}-${child.pid}.log`);
      serviceLogStream = fs.createWriteStream(logFile, { flags: "a" });
      serviceLogStream.write(`[${new Date().toISOString()}] spawn pid=${child.pid}${EOL}`);
      serviceLogStream.write(`[${new Date().toISOString()}] projectId=${projectId}${EOL}`);
      serviceLogStream.write(`[${new Date().toISOString()}] projectPath=${projectPath}${EOL}`);
      serviceLogStream.write(`[${new Date().toISOString()}] servicePath=${servicePath}${EOL}`);
    } catch {
      serviceLogStream = null;
    }
  }

  const writeServiceLog = (kind: "stdout" | "stderr", chunk: unknown) => {
    if (!serviceLogStream) return;
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!text) return;
      const ts = new Date().toISOString();
      const normalized = text.replace(/\r\n/g, "\n");
      for (const line of normalized.split("\n")) {
        if (!line) continue;
        serviceLogStream.write(`[${ts}] ${kind}: ${line}${EOL}`);
      }
    } catch {
      // ignore
    }
  };

  if (shouldLogService) {
    child.stdout?.on("data", (d) => writeServiceLog("stdout", d));
    child.stderr?.on("data", (d) => writeServiceLog("stderr", d));
  }

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
  child.on("exit", (code, signal) => {
    if (serviceLogStream) {
      try {
        serviceLogStream.write(
          `[${new Date().toISOString()}] exit code=${code ?? "null"} signal=${signal ?? "null"}${EOL}`
        );
        serviceLogStream.end();
      } catch {
        // ignore
      }
      serviceLogStream = null;
    }
    pending.forEach((handler, id) => handler({ id, ok: false, error: "service_exited" }));
    pending.clear();
    projectServices.delete(projectId);
  });
  child.on("error", (err) => {
    if (!serviceLogStream) return;
    try {
      serviceLogStream.write(
        `[${new Date().toISOString()}] process_error: ${err instanceof Error ? err.stack || err.message : String(err)}${EOL}`
      );
    } catch {
      // ignore
    }
  });

  const entry: ProjectServiceEntry = { child, pending };
  projectServices.set(projectId, entry);

  void sendToProjectService(projectId, { type: "init", projectPath });
  return entry;
}

export async function freezeProjectService(projectId: string) {
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

export function scheduleFreeze(projectId: string) {
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

export function cancelScheduledFreeze(projectId: string) {
  const existing = freezeTimers.get(projectId);
  if (existing) clearTimeout(existing);
  freezeTimers.delete(projectId);
}

export function sendToProjectService(projectId: string, payload: ProjectServiceRequestNoId): Promise<ProjectServiceResponse> {
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
