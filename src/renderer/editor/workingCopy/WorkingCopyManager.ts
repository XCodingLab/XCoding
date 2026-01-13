import type * as monaco from "monaco-editor";
import { WorkingCopy } from "./WorkingCopy";

type Entry = { workingCopy: WorkingCopy; refs: number };
type AutoSaveConfig = { autoSave: "off" | "afterDelay"; autoSaveDelayMs: number };

function keyFor(slot: number, relPath: string) {
  return `${slot}:${relPath}`;
}

export class WorkingCopyManager {
  private entries = new Map<string, Entry>();
  private disposeProjectEvents: (() => void) | null = null;
  private disposeProjectsState: (() => void) | null = null;
  private slotToProjectId = new Map<number, string>();
  private autoSave: AutoSaveConfig = { autoSave: "off", autoSaveDelayMs: 1000 };

  acquire(slot: number, relPath: string) {
    this.ensureProjectEventSubscription();
    const key = keyFor(slot, relPath);
    const existing = this.entries.get(key);
    if (existing) {
      existing.refs += 1;
      return existing.workingCopy;
    }
    const workingCopy = new WorkingCopy(slot, relPath);
    workingCopy.setAutoSaveConfig(this.autoSave);
    this.entries.set(key, { workingCopy, refs: 1 });
    void workingCopy.resolveFromDisk("open");
    return workingCopy;
  }

  release(slot: number, relPath: string) {
    const key = keyFor(slot, relPath);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.entries.delete(key);
    entry.workingCopy.dispose();
  }

  get(slot: number, relPath: string) {
    return this.entries.get(keyFor(slot, relPath))?.workingCopy ?? null;
  }

  list(slot: number) {
    const out: WorkingCopy[] = [];
    for (const entry of this.entries.values()) {
      if (entry.workingCopy.slot !== slot) continue;
      out.push(entry.workingCopy);
    }
    return out;
  }

  getByUri(uri: monaco.Uri) {
    const relPath = uri.path.replace(/^\/+/, "");
    // Slot cannot be derived from uri; this is best-effort across current entries.
    for (const entry of this.entries.values()) {
      if (entry.workingCopy.relPath === relPath) return entry.workingCopy;
    }
    return null;
  }

  setAutoSaveConfig(config: AutoSaveConfig) {
    const autoSave = config.autoSave === "afterDelay" ? "afterDelay" : "off";
    const autoSaveDelayMs = Math.max(200, Math.min(60_000, Math.floor(Number(config.autoSaveDelayMs) || 1000)));
    this.autoSave = { autoSave, autoSaveDelayMs };
    for (const entry of this.entries.values()) {
      entry.workingCopy.setAutoSaveConfig(this.autoSave);
    }
  }

  private ensureProjectsStateSubscription() {
    if (this.disposeProjectsState) return;

    const applyState = (state: any) => {
      if (!state || typeof state !== "object") return;
      const slots = Array.isArray((state as any).slots) ? (state as any).slots : [];
      this.slotToProjectId.clear();
      for (const slot of slots) {
        const slotNumber = Number((slot as any)?.slot);
        const projectId = typeof (slot as any)?.projectId === "string" ? String((slot as any).projectId) : "";
        if (!Number.isFinite(slotNumber) || slotNumber <= 0) continue;
        if (!projectId) continue;
        this.slotToProjectId.set(slotNumber, projectId);
      }
    };

    void (async () => {
      try {
        const res = await window.xcoding.projects.get();
        if (res?.ok) applyState((res as any).state);
      } catch {
        // ignore
      }
    })();

    this.disposeProjectsState = window.xcoding.projects.onState((payload) => {
      try {
        applyState((payload as any)?.state);
      } catch {
        // ignore
      }
    });
  }

  private ensureProjectEventSubscription() {
    if (this.disposeProjectEvents) return;
    this.ensureProjectsStateSubscription();
    this.disposeProjectEvents = window.xcoding.events.onProjectEvent((evt) => {
      if (!evt || typeof evt !== "object") return;
      if ((evt as any).type !== "watcher") return;
      const projectId = typeof (evt as any).projectId === "string" ? String((evt as any).projectId) : "";
      if (!projectId) return;
      const path = typeof (evt as any).path === "string" ? String((evt as any).path) : "";
      if (!path || path.endsWith("/")) return;
      const event = typeof (evt as any).event === "string" ? String((evt as any).event) : "";
      if (!event) return;

      for (const entry of this.entries.values()) {
        const slotProjectId = this.slotToProjectId.get(entry.workingCopy.slot);
        if (!slotProjectId || slotProjectId !== projectId) continue;
        if (entry.workingCopy.relPath !== path) continue;
        void entry.workingCopy.handleWatcherEvent({ event, path });
      }
    });
  }
}

export const workingCopyManager = new WorkingCopyManager();
