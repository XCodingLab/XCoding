import * as monaco from "monaco-editor";
import { MONACO_URI_SCHEME } from "../../monacoSetup";
import { languageFromPath, type MonacoLanguageId } from "../../languageSupport";
import type { WorkingCopyListener, WorkingCopySnapshot } from "./workingCopyTypes";

type ReadFileResult =
  | {
      ok: true;
      content: string;
      truncated: boolean;
      isBinary: boolean;
      size: number;
      mtimeMs: number;
    }
  | { ok: false; reason: string };

type WriteFileResult = { ok: true } | { ok: false; reason: string };

function toUri(relPath: string) {
  return monaco.Uri.from({ scheme: MONACO_URI_SCHEME, path: `/${relPath}` });
}

export class WorkingCopy {
  readonly slot: number;
  readonly relPath: string;
  readonly uri: monaco.Uri;

  private model: monaco.editor.ITextModel;
  private savedVersionId: number;
  private ignoreModelContentChange = false;
  private listeners = new Set<WorkingCopyListener>();
  private disposables: monaco.IDisposable[] = [];
  private operation = Promise.resolve();
  private reloadTimer: number | null = null;
  private autoSaveTimer: number | null = null;
  private autoSave: { autoSave: "off" | "afterDelay"; autoSaveDelayMs: number } = { autoSave: "off", autoSaveDelayMs: 1000 };
  private ignoreWatcherUntil = 0;

  private snapshot: WorkingCopySnapshot;

  constructor(slot: number, relPath: string) {
    this.slot = slot;
    this.relPath = relPath;
    this.uri = toUri(relPath);

    const languageId = languageFromPath(relPath);
    const existing = monaco.editor.getModel(this.uri);
    this.model = existing ?? monaco.editor.createModel("", languageId === "plaintext" ? undefined : languageId, this.uri);
    if (existing) monaco.editor.setModelLanguage(existing, languageId);

    this.savedVersionId = this.model.getAlternativeVersionId();
    this.snapshot = {
      slot,
      relPath,
      uri: this.uri,
      languageId,
      isResolved: false,
      isLoading: false,
      error: null,
      dirty: false,
      conflict: false,
      orphaned: false,
      isBinary: false,
      truncated: false,
      size: 0,
      mtimeMs: 0
    };

    this.disposables.push(
      this.model.onDidChangeContent(() => {
        if (this.ignoreModelContentChange) return;
        const dirty = this.model.getAlternativeVersionId() !== this.savedVersionId;
        if (dirty !== this.snapshot.dirty) {
          this.setSnapshot({ dirty });
        }
        if (dirty) this.scheduleAutoSave();
        else this.clearAutoSave();
        // If we had a conflict but the user reverted back to saved state,
        // we can safely refresh from disk (VS Code never reloads dirty files).
        if (!dirty && this.snapshot.conflict) {
          this.scheduleReload("reverted_clean");
        }
      })
    );
  }

  dispose() {
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.clearAutoSave();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    try {
      this.model.dispose();
    } catch {
      // ignore
    }
    this.listeners.clear();
  }

  getModel() {
    return this.model;
  }

  getSnapshot(): WorkingCopySnapshot {
    return this.snapshot;
  }

  subscribe(listener: WorkingCopyListener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  setAutoSaveConfig(config: { autoSave: "off" | "afterDelay"; autoSaveDelayMs: number }) {
    const autoSave = config.autoSave === "afterDelay" ? "afterDelay" : "off";
    const autoSaveDelayMs = Math.max(200, Math.min(60_000, Math.floor(Number(config.autoSaveDelayMs) || 1000)));
    this.autoSave = { autoSave, autoSaveDelayMs };
    if (autoSave === "off") this.clearAutoSave();
    else if (this.snapshot.dirty) this.scheduleAutoSave();
  }

  private setSnapshot(patch: Partial<WorkingCopySnapshot>) {
    const next = { ...this.snapshot, ...patch };
    this.snapshot = next;
    for (const l of this.listeners) l(next);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operation.then(fn, fn);
    this.operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private clearAutoSave() {
    if (this.autoSaveTimer != null) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
  }

  private scheduleAutoSave() {
    if (this.autoSave.autoSave !== "afterDelay") return;
    if (!this.snapshot.dirty) return;
    if (this.snapshot.conflict) return;
    if (this.snapshot.isBinary || this.snapshot.truncated) return;
    this.clearAutoSave();
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      if (!this.snapshot.dirty) return;
      if (this.snapshot.conflict) return;
      if (this.snapshot.isBinary || this.snapshot.truncated) return;
      void this.save();
    }, this.autoSave.autoSaveDelayMs);
  }

  async resolveFromDisk(reason: "open" | "reload" | "watcher" = "open") {
    return this.enqueue(async () => {
      this.setSnapshot({ isLoading: true });

      let res: ReadFileResult;
      try {
        res = (await window.xcoding.project.readFile({ slot: this.slot, path: this.relPath })) as any;
      } catch (e) {
        res = { ok: false, reason: e instanceof Error ? e.message : "read_failed" };
      }

      if (!res.ok) {
        const orphaned = res.reason === "file_not_found" ? true : this.snapshot.orphaned;
        this.setSnapshot({ isLoading: false, isResolved: true, error: res.reason, orphaned });
        return;
      }

      const languageId = languageFromPath(this.relPath);
      this.setSnapshot({
        isLoading: false,
        isResolved: true,
        error: null,
        languageId,
        truncated: Boolean(res.truncated),
        isBinary: Boolean(res.isBinary),
        size: Number(res.size ?? 0),
        mtimeMs: Number(res.mtimeMs ?? 0)
      });

      if (res.isBinary || res.truncated) {
        // Keep the existing buffer as-is; the UI will render an unsupported placeholder.
        return;
      }

      // Apply content without affecting dirty tracking.
      this.ignoreModelContentChange = true;
      try {
        if (monaco.editor.getModel(this.uri) !== this.model) {
          // Model got recreated externally (should be rare); rebind.
          const existing = monaco.editor.getModel(this.uri);
          if (existing) this.model = existing;
        }
        monaco.editor.setModelLanguage(this.model, languageId);
        this.model.setValue(String(res.content ?? ""));
      } finally {
        this.ignoreModelContentChange = false;
      }

      this.savedVersionId = this.model.getAlternativeVersionId();
      this.setSnapshot({ dirty: false, conflict: false, orphaned: false });
      this.clearAutoSave();

      if (import.meta.env.DEV && reason !== "open") {
        console.debug("[workingCopy] reloaded", { path: this.relPath, reason });
      }
    });
  }

  async save() {
    return this.enqueue(async () => {
      if (this.snapshot.isLoading || !this.snapshot.isResolved) return;
      if (this.snapshot.isBinary || this.snapshot.truncated) return;
      const content = this.model.getValue();
      let res: WriteFileResult;
      try {
        res = (await window.xcoding.project.writeFile({ slot: this.slot, path: this.relPath, content })) as any;
      } catch (e) {
        res = { ok: false, reason: e instanceof Error ? e.message : "save_failed" };
      }

      if (!res.ok) {
        this.setSnapshot({ error: res.reason });
        return;
      }

      this.ignoreWatcherUntil = Date.now() + 600;
      this.savedVersionId = this.model.getAlternativeVersionId();
      this.setSnapshot({ error: null, dirty: false, conflict: false, orphaned: false });
      this.clearAutoSave();
    });
  }

  scheduleReload(reason: "watcher" | "reverted_clean" | "manual") {
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
    const delay = reason === "manual" ? 0 : 180;
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      if (this.snapshot.dirty) return;
      void this.resolveFromDisk(reason === "manual" ? "reload" : "watcher");
    }, delay);
  }

  async handleWatcherEvent(evt: { event: string; path: string }) {
    if (Date.now() < this.ignoreWatcherUntil) return;
    const event = String(evt.event ?? "");
    if (event === "change" || event === "add") {
      if (!this.snapshot.dirty) {
        this.scheduleReload("watcher");
      } else if (!this.snapshot.conflict) {
        this.setSnapshot({ conflict: true });
        this.clearAutoSave();
      }
      return;
    }
    if (event === "unlink") {
      if (!this.snapshot.orphaned) this.setSnapshot({ orphaned: true });
      return;
    }
  }
}
