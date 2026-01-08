import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { broadcast } from "../app/windowManager";
import type { ProjectServiceRequestNoId, ProjectServiceResponse } from "../shared/projectServiceProtocol";
import { resolveRunAsNodeExecutablePath } from "../shared/runAsNodeExecutable";

type AiStaging = {
  patchId: string;
  fileEdits: Array<{ path: string; content: string }>;
  snapshot?: Array<{ path: string; existed: boolean; content?: string }>;
  createdAt: number;
  appliedAt?: number;
  revertedAt?: number;
};

const aiStagingBySlot = new Map<number, AiStaging[]>();
let aiService: { child: ChildProcess; pending: Map<string, (res: any) => void> } | null = null;
const aiChatSlotByRequestId = new Map<string, number>();

function ensureAiService() {
  if (aiService && aiService.child.exitCode === null) return aiService;
  const servicePath = path.join(__dirname, "aiService.cjs");
  const child = spawn(resolveRunAsNodeExecutablePath(), [servicePath], {
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

export function broadcastAiStatus(slot: number, status: "idle" | "running" | "done" | "error") {
  broadcast("ai:status", { slot, status, timestamp: Date.now() });
}

export function startChat({
  slot,
  requestId,
  messages,
  apiBase,
  apiKey,
  model
}: {
  slot: number;
  requestId: string;
  messages: Array<{ role: string; content: string }>;
  apiBase: string;
  apiKey: string;
  model: string;
}) {
  aiChatSlotByRequestId.set(requestId, slot);
  broadcastAiStatus(slot, "running");
  sendToAiService({
    id: requestId,
    type: "chat:start",
    apiBase,
    apiKey,
    model,
    messages
  });
  return { ok: true as const };
}

export function cancelChat({ slot, requestId }: { slot: number; requestId: string }) {
  sendToAiService({ id: requestId, type: "chat:cancel" });
  broadcastAiStatus(slot, "idle");
  return { ok: true as const };
}

export function stageEdits(slot: number, fileEdits: Array<{ path: string; content: string }>) {
  const patchId = `patch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const entry: AiStaging = { patchId, fileEdits, createdAt: Date.now() };
  const list = aiStagingBySlot.get(slot) ?? [];
  list.push(entry);
  aiStagingBySlot.set(slot, list.slice(-20));
  return { ok: true as const, patchId };
}

export function getStaging(slot: number) {
  const list = aiStagingBySlot.get(slot) ?? [];
  return {
    ok: true as const,
    staging: list.map((p) => ({
      patchId: p.patchId,
      fileEdits: p.fileEdits.map((e) => ({ path: e.path })),
      createdAt: p.createdAt,
      appliedAt: p.appliedAt,
      revertedAt: p.revertedAt
    }))
  };
}

export function clearSlotStaging(slot: number) {
  aiStagingBySlot.delete(slot);
}

export async function applyAll({
  slot,
  getProjectForSlot,
  sendToProjectService
}: {
  slot: number;
  getProjectForSlot: (slot: number) => { id: string; path: string } | null;
  sendToProjectService: (projectId: string, payload: ProjectServiceRequestNoId) => Promise<ProjectServiceResponse>;
}) {
  const list = aiStagingBySlot.get(slot) ?? [];
  const now = Date.now();
  const patch = [...list].reverse().find((e) => !e.appliedAt && !e.revertedAt);
  if (!patch) return { ok: true as const, appliedFiles: [] as string[] };
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
    return { ok: true as const, appliedFiles: Array.from(new Set(appliedFiles)) };
  } catch (e) {
    broadcastAiStatus(slot, "error");
    return { ok: false as const, reason: e instanceof Error ? e.message : "apply_failed" };
  }
}

export async function revertLast({
  slot,
  getProjectForSlot,
  sendToProjectService
}: {
  slot: number;
  getProjectForSlot: (slot: number) => { id: string; path: string } | null;
  sendToProjectService: (projectId: string, payload: ProjectServiceRequestNoId) => Promise<ProjectServiceResponse>;
}) {
  const list = aiStagingBySlot.get(slot) ?? [];
  const lastApplied = [...list].reverse().find((e) => e.appliedAt && !e.revertedAt);
  if (!lastApplied) return { ok: true as const, revertedFiles: [] as string[] };
  if (!lastApplied.snapshot) return { ok: false as const, reason: "no_snapshot" as const };
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
    return { ok: true as const, revertedFiles: Array.from(new Set(revertedFiles)) };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "revert_failed" };
  }
}
