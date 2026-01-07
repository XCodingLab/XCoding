import { app } from "electron";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CodexBridge } from "../codexBridge";
import { ensureCodexExecutableIsRunnable, resolveCodexExecutablePath } from "../codexExecutable";
import { broadcast } from "../app/windowManager";

type CodexLastStatus = { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string };

type CodexTurnSnapshotEntry = { relPath: string; absPath: string; existed: boolean; snapshotFile: string };
type CodexTurnSnapshot = { threadId: string; turnId: string; cwd: string; createdAt: number; entries: CodexTurnSnapshotEntry[] };
const codexTurnSnapshotsByKey = new Map<string, CodexTurnSnapshot>();

let codexBridge: CodexBridge | null = null;
let codexHomePath: string | null = null;
const codexPendingRequestsById = new Map<number, { method: string; params: any }>();
let codexLastStatus: CodexLastStatus = { state: "idle" };
let codexLastStderr = "";

export function getCodexStatusSnapshot() {
  return { status: codexLastStatus, lastStderr: codexLastStderr, codexHome: codexHomePath };
}

export function disposeCodexBridge(reason: string) {
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

export function disposeCodexBridgeForUiGone() {
  // If the UI goes away (dev window reload/crash/close), proactively stop codex app-server
  // so we don't leave orphaned background processes around.
  try {
    codexBridge?.dispose();
  } catch {
    // ignore
  }
  codexBridge = null;
  codexHomePath = null;
}

export function ensureCodexBridge() {
  // 固定使用 ~/.codex（不支持备用回退或用户自定义 CODEX_HOME），以复用 VS Code 插件的历史记录与配置。
  const home = homedir();
  const desiredCodexHome = path.join(home, ".codex");
  const resolvedExe = resolveCodexExecutablePath();
  if (resolvedExe.path) ensureCodexExecutableIsRunnable(resolvedExe.path);
  if (codexBridge && codexHomePath === desiredCodexHome) return codexBridge;
  if (codexBridge) codexBridge.dispose();
  codexHomePath = desiredCodexHome;
  codexBridge = new CodexBridge({
    clientInfo: { name: "xcoding-ide", title: "XCoding", version: app.getVersion() },
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

export async function tryFetchCustomModelList(): Promise<any | null> {
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

export function extractCodexFileChangePaths(params: any): string[] {
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

export function revertCodexTurnSnapshot(threadId: string, turnId: string) {
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

export function applyCodexTurnSnapshot(threadId: string, turnId: string) {
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

function isProbablyBinaryBuffer(buf: Buffer) {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (!sample.length) return false;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}

function readFileLimited(absPath: string, maxBytes: number): { buf: Buffer; truncated: boolean } {
  const st = fs.statSync(absPath);
  if (!st.isFile()) return { buf: Buffer.from(""), truncated: false };
  const truncated = st.size > maxBytes;
  const size = truncated ? maxBytes : st.size;
  if (size <= 0) return { buf: Buffer.from(""), truncated };
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, 0);
    return { buf: read === size ? buf : buf.subarray(0, read), truncated };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function safeReadSnapshotManifest(threadId: string, turnId: string): any | null {
  const root = ensureCodexSnapshotsRoot();
  const snapDir = path.join(root, encodeURIComponent(threadId), encodeURIComponent(turnId));
  const manifestPath = path.join(snapDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readCodexTurnFileDiff({
  threadId,
  turnId,
  relPath,
  maxBytes
}: {
  threadId: string;
  turnId: string;
  relPath: string;
  maxBytes?: number;
}):
  | { ok: true; original: string; modified: string; truncated: boolean; isBinary: boolean }
  | { ok: false; reason: string } {
  const normalizedThreadId = String(threadId ?? "").trim();
  const normalizedTurnId = String(turnId ?? "").trim();
  const normalizedRelPath = safeRelPath(relPath);
  const limit = typeof maxBytes === "number" ? Math.max(50_000, Math.min(15_000_000, Math.floor(maxBytes))) : 3_000_000;

  if (!normalizedThreadId || !normalizedTurnId || !normalizedRelPath) return { ok: false, reason: "missing_ids_or_path" };

  const snapshot = safeReadSnapshotManifest(normalizedThreadId, normalizedTurnId);
  if (!snapshot) return { ok: false, reason: "no_snapshot" };
  const snapshotCwd = typeof snapshot?.cwd === "string" ? snapshot.cwd : "";
  const resolvedSnapshotCwd = snapshotCwd ? path.resolve(snapshotCwd) : "";
  if (!resolvedSnapshotCwd) return { ok: false, reason: "invalid_snapshot_cwd" };
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const entry = entries.find((e: any) => safeRelPath(e?.relPath) === normalizedRelPath) ?? null;
  if (!entry) return { ok: false, reason: "snapshot_entry_not_found" };

  const root = ensureCodexSnapshotsRoot();
  const snapDir = path.join(root, encodeURIComponent(normalizedThreadId), encodeURIComponent(normalizedTurnId));
  const snapshotFileName = String(entry?.snapshotFile ?? "");
  const snapshotFile = snapshotFileName ? path.join(snapDir, snapshotFileName) : "";
  const resolvedSnapshotFile = snapshotFile ? path.resolve(snapshotFile) : "";
  const resolvedSnapDir = path.resolve(snapDir);
  if (!resolvedSnapshotFile || !resolvedSnapshotFile.startsWith(resolvedSnapDir + path.sep)) return { ok: false, reason: "invalid_snapshot_path" };

  let truncated = false;
  let isBinary = false;

  let originalBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  const existed = Boolean(entry?.existed);
  if (existed && fs.existsSync(resolvedSnapshotFile)) {
    const r = readFileLimited(resolvedSnapshotFile, limit);
    truncated = truncated || r.truncated;
    originalBuf = r.buf;
    isBinary = isBinary || isProbablyBinaryBuffer(originalBuf);
  }

  let modifiedBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  const absPath = String(entry?.absPath ?? "");
  const resolvedAbs = absPath ? path.resolve(absPath) : "";
  if (resolvedAbs && (resolvedAbs === resolvedSnapshotCwd || resolvedAbs.startsWith(resolvedSnapshotCwd + path.sep)) && fs.existsSync(resolvedAbs)) {
    try {
      const r = readFileLimited(resolvedAbs, limit);
      truncated = truncated || r.truncated;
      modifiedBuf = r.buf;
      isBinary = isBinary || isProbablyBinaryBuffer(modifiedBuf);
    } catch {
      modifiedBuf = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
    }
  } else if (resolvedAbs) {
    return { ok: false, reason: "invalid_abs_path" };
  }

  if (isBinary) return { ok: true, original: "", modified: "", truncated: false, isBinary: true };

  return {
    ok: true,
    original: originalBuf.toString("utf8"),
    modified: modifiedBuf.toString("utf8"),
    truncated,
    isBinary: false
  };
}

export async function restartCodexBridge() {
  if (codexBridge) codexBridge.dispose();
  codexBridge = null;
  codexHomePath = null;
  await ensureCodexBridge().ensureStarted();
}

export function respondToCodex({ id, result, error }: { id: number; result?: any; error?: any }) {
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
}
