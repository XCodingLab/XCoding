import { app } from "electron";
import { broadcast } from "../app/windowManager";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { resolveBundledClaudeCode } from "./claudeExecutable";
import type { ChildProcess } from "node:child_process";
import { resolveRunAsNodeExecutablePath } from "../shared/runAsNodeExecutable";

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

type ClaudeStatus = { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string };

type ClaudeToolPermissionRequest = {
  requestId: string;
  slot: number;
  sessionId: string;
  toolName: string;
  toolInput: any;
  suggestions?: any;
  toolUseId?: string;
};

type PendingPermission = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

type SlotState = {
  slot: number;
  projectRootPath: string;
  sessionId: string | null;
  permissionMode: ClaudePermissionMode;
  q: Query | null;
  input: PushableAsyncIterable<SDKUserMessage> | null;
  childProc: ChildProcess | null;
  pendingPermissions: Map<string, PendingPermission>;
  status: ClaudeStatus;
  forkSession: boolean;
  sessionIdWaiters: Array<(sessionId: string) => void>;
};

const slots = new Map<number, SlotState>();

let sdkModulePromise: Promise<typeof import("@anthropic-ai/claude-agent-sdk")> | null = null;
async function getClaudeAgentSdk() {
  if (!sdkModulePromise) sdkModulePromise = import("@anthropic-ai/claude-agent-sdk");
  return await sdkModulePromise;
}

class PushableAsyncIterable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T) {
    if (this.done) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.queue.push(value);
  }

  end() {
    if (this.done) return;
    this.done = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as any, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as T, done: false });
        if (this.done) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      }
    };
  }
}

function getOrCreateSlotState(slot: number): SlotState {
  const existing = slots.get(slot);
  if (existing) return existing;
  const next: SlotState = {
    slot,
    projectRootPath: "",
    sessionId: null,
    permissionMode: "default",
    q: null,
    input: null,
    childProc: null,
    pendingPermissions: new Map(),
    status: { state: "idle" },
    forkSession: false,
    sessionIdWaiters: []
  };
  slots.set(slot, next);
  return next;
}

function makeRequestId() {
  return `claude-req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function publishEvent(event: any) {
  broadcast("claude:event", event);
}

function publishRequest(req: ClaudeToolPermissionRequest) {
  broadcast("claude:request", req);
}

function publishLog(slot: number, message: string, data?: any) {
  publishEvent({ kind: "log", slot, message, data });
}

function makeIdeSystemPromptAppend(projectRootPath: string) {
  // Minimal for MVP; we can enrich with selection/tabs later (similar to VSCode plugin's append).
  return `\n\nYou are running inside XCoding.\nProject root: ${projectRootPath}\n`;
}

function cliEnvBase() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Avoid user NODE_OPTIONS affecting spawned CLI runtime.
  delete env.NODE_OPTIONS;
  // Identify entrypoint for Claude telemetry / behavior.
  env.CLAUDE_CODE_ENTRYPOINT = env.CLAUDE_CODE_ENTRYPOINT || "xcoding-ide";
  // Disable nonessential traffic / installers where supported by cli.js.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1";
  env.DISABLE_AUTOUPDATER = env.DISABLE_AUTOUPDATER || "1";
  env.DISABLE_INSTALLATION_CHECKS = env.DISABLE_INSTALLATION_CHECKS || "1";
  env.DISABLE_AUTO_MIGRATE_TO_NATIVE = env.DISABLE_AUTO_MIGRATE_TO_NATIVE || "1";
  return env;
}

function spawnClaudeCodeProcessForSlot(slot: number) {
  return (options: any) => {
    const bundled = resolveBundledClaudeCode();
    if (!bundled) throw new Error("claude_code_bundle_missing");

    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const execPath = resolveRunAsNodeExecutablePath();
    const env = { ...cliEnvBase(), ...(options?.env ?? {}) };
    delete env.NODE_OPTIONS;
    env.ELECTRON_RUN_AS_NODE = "1";
    const cwd = typeof options?.cwd === "string" && options.cwd ? options.cwd : process.cwd();
    const args = Array.isArray(options?.args) ? options.args : [];
    const signal = options?.signal as AbortSignal | undefined;

    publishLog(slot, "spawnClaudeCodeProcess", { cwd, args });

    const child = spawn(execPath, [bundled.cliJsPath, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal
    });
    const s = getOrCreateSlotState(slot);
    s.childProc = child;

    child.stderr?.on("data", (buf: Buffer) => {
      publishEvent({ kind: "stderr", slot, text: buf.toString("utf8") });
    });
    child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
      if (s.childProc === child) s.childProc = null;
      publishLog(slot, "claude_code_process.close", { code, signal: sig });
    });
    child.on("error", (err: Error) => {
      if (s.childProc === child) s.childProc = null;
      publishLog(slot, "claude_code_process.error", { message: err.message });
    });

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      kill: child.kill.bind(child),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child)
    };
  };
}

export function getClaudeStatus(slot: number) {
  const s = getOrCreateSlotState(slot);
  return { status: s.status, slot: s.slot, sessionId: s.sessionId, permissionMode: s.permissionMode };
}

export async function getClaudeMcpServerStatus(slot: number) {
  const s = getOrCreateSlotState(slot);
  try {
    const list = await (s.q as any)?.mcpServerStatus?.();
    return { ok: true as const, servers: Array.isArray(list) ? list : [] };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "mcp_status_failed" };
  }
}

export async function ensureClaudeStarted({
  slot,
  projectRootPath,
  sessionId,
  permissionMode,
  forkSession
}: {
  slot: number;
  projectRootPath: string;
  sessionId?: string | null;
  permissionMode?: ClaudePermissionMode;
  forkSession?: boolean;
}) {
  const s = getOrCreateSlotState(slot);
  s.projectRootPath = String(projectRootPath || "");
  const requestedMode = typeof permissionMode === "string" ? permissionMode : null;
  if (requestedMode) s.permissionMode = requestedMode;
  const requestedSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
  if (typeof forkSession === "boolean") s.forkSession = forkSession;

  if (s.q) {
    if (requestedSessionId && requestedSessionId !== s.sessionId) {
      publishLog(slot, "ensureClaudeStarted.restartForSession", { from: s.sessionId, to: requestedSessionId });
      try {
        await s.q.interrupt();
      } catch {
        // ignore
      }
      try {
        await (s.q as any)?.return?.();
      } catch {
        // ignore
      }
      try {
        if (s.childProc && s.childProc.exitCode === null) s.childProc.kill("SIGTERM");
      } catch {
        // ignore
      }
      s.childProc = null;
      s.q = null;
      s.input = null;
      s.sessionId = null;
    } else {
      if (requestedMode) {
        try {
          await (s.q as any)?.setPermissionMode?.(requestedMode);
          publishLog(slot, "ensureClaudeStarted.setPermissionMode", { mode: requestedMode });
        } catch (e) {
          publishLog(slot, "ensureClaudeStarted.setPermissionMode_failed", { mode: requestedMode, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { ok: true as const, sessionId: s.sessionId, permissionMode: s.permissionMode };
    }
  }

  if (requestedSessionId) s.sessionId = requestedSessionId;

  if (s.q) {
    if (requestedMode) {
      try {
        await (s.q as any)?.setPermissionMode?.(requestedMode);
        publishLog(slot, "ensureClaudeStarted.setPermissionMode", { mode: requestedMode });
      } catch (e) {
        publishLog(slot, "ensureClaudeStarted.setPermissionMode_failed", { mode: requestedMode, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ok: true as const, sessionId: s.sessionId, permissionMode: s.permissionMode };
  }

  const bundled = resolveBundledClaudeCode();
  if (!bundled) return { ok: false as const, reason: "claude_code_bundle_missing" as const };

  publishLog(slot, "ensureClaudeStarted.begin", { projectRootPath: s.projectRootPath, permissionMode: s.permissionMode, sessionId: s.sessionId });

  s.status = { state: "starting" };
  publishEvent({ kind: "status", slot, status: s.status });

  const input = new PushableAsyncIterable<SDKUserMessage>();
  s.input = input;

  const { query } = await getClaudeAgentSdk();
  const q = query({
    prompt: input,
    options: {
      cwd: s.projectRootPath || process.cwd(),
      includePartialMessages: true,
      enableFileCheckpointing: true,
      settingSources: ["user", "project", "local"],
      allowDangerouslySkipPermissions: true,
      permissionMode: s.permissionMode,
      ...(s.sessionId
        ? {
            resume: s.sessionId,
            continueConversation: true,
            ...(s.forkSession ? { forkSession: true } : {}),
            // resumeSessionAt is print-mode only; ignored here.
          }
        : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: makeIdeSystemPromptAppend(s.projectRootPath) },
      spawnClaudeCodeProcess: spawnClaudeCodeProcessForSlot(slot),
      // Important: use our bundled cli.js path; SDK will treat this as "executable" argument in args list.
      pathToClaudeCodeExecutable: bundled.cliJsPath as any,
      executable: process.execPath as any,
      stderr: (err) => publishEvent({ kind: "stderr", slot, text: String(err ?? "") }),
      canUseTool: async (toolName, toolInput, meta: any) => {
        if (s.permissionMode === "bypassPermissions") {
          publishLog(slot, "permission.autoAllow", { mode: s.permissionMode, toolName: String(toolName ?? "") });
          return { behavior: "allow", updatedInput: toolInput } as any;
        }

        const requestId = makeRequestId();
        publishLog(slot, "permission.request", {
          toolName: String(toolName ?? ""),
          toolUseId: meta?.toolUseID ?? meta?.tool_use_id,
          decisionReason: meta?.decisionReason,
          blockedPath: meta?.blockedPath
        });
        publishRequest({
          requestId,
          slot,
          sessionId: s.sessionId || "",
          toolName: String(toolName ?? ""),
          toolInput,
          suggestions: meta?.suggestions,
          toolUseId: meta?.toolUseID ?? meta?.tool_use_id
        });
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            s.pendingPermissions.delete(requestId);
            resolve({ behavior: "deny", message: "Timed out waiting for permission response", interrupt: true });
          }, 120_000);
          s.pendingPermissions.set(requestId, { resolve, reject, timer });
        });
      }
    }
  });

  s.q = q as unknown as Query;

  // Start streaming asynchronously.
  (async () => {
    try {
      for await (const ev of q) {
        if (ev && typeof ev === "object" && (ev as any).type === "system" && (ev as any).subtype === "init") {
          const nextSessionId = typeof (ev as any).session_id === "string" ? (ev as any).session_id : null;
          const initPermissionMode = typeof (ev as any).permissionMode === "string" ? String((ev as any).permissionMode) : null;
          if (nextSessionId && nextSessionId !== s.sessionId) {
            s.sessionId = nextSessionId;
            publishLog(slot, "session.init", { sessionId: s.sessionId, permissionMode: initPermissionMode });
            for (const w of s.sessionIdWaiters.splice(0)) w(nextSessionId);
          }
        }
        publishEvent({ kind: "stream", slot, event: ev });
      }
      s.status = { state: "exited" };
      publishEvent({ kind: "status", slot, status: s.status });
    } catch (e) {
      s.status = { state: "error", error: e instanceof Error ? e.message : "claude_stream_error" };
      publishEvent({ kind: "status", slot, status: s.status });
      publishLog(slot, "stream.error", { error: s.status.error });
    } finally {
      s.q = null;
      s.input = null;
      publishLog(slot, "stream.end");
    }
  })();

  s.status = { state: "ready" };
  publishEvent({ kind: "status", slot, status: s.status, version: app.getVersion(), claudeCodeVersion: bundled.version });
  publishLog(slot, "ensureClaudeStarted.ready", { claudeCodeVersion: bundled.version });

  // Wait briefly for system:init to populate sessionId so renderer can reliably resume/fork.
  const awaitSessionId = async (): Promise<string | null> => {
    if (s.sessionId) return s.sessionId;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      s.sessionIdWaiters.push((sid) => {
        clearTimeout(timer);
        resolve(sid);
      });
    });
  };

  const effectiveSessionId = await awaitSessionId();
  // Clear fork flags after starting.
  s.forkSession = false;
  return { ok: true as const, sessionId: effectiveSessionId, permissionMode: s.permissionMode };
}

export async function sendClaudeUserMessage({ slot, content }: { slot: number; content: string }) {
  const s = getOrCreateSlotState(slot);
  if (!s.input || !s.q) {
    publishLog(slot, "sendUserMessage.not_started");
    return { ok: false as const, reason: "not_started" as const };
  }
  const text = String(content ?? "");
  if (!text.trim()) return { ok: false as const, reason: "empty" as const };
  publishLog(slot, "sendUserMessage", { length: text.length });
  s.input.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: s.sessionId || ""
  } as any);
  return { ok: true as const };
}

export async function interruptClaude(slot: number) {
  const s = getOrCreateSlotState(slot);
  publishLog(slot, "interrupt");
  try {
    await s.q?.interrupt?.();
  } catch {
    // ignore
  }
  return { ok: true as const };
}

export async function closeClaude(slot: number) {
  const s = getOrCreateSlotState(slot);
  publishLog(slot, "close");
  for (const [id, pending] of s.pendingPermissions.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("claude_closed"));
    s.pendingPermissions.delete(id);
  }
  try {
    await s.q?.interrupt?.();
  } catch {
    // ignore
  }
  try {
    await (s.q as any)?.return?.();
  } catch {
    // ignore
  }
  try {
    if (s.childProc && s.childProc.exitCode === null) s.childProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  s.childProc = null;
  s.q = null;
  s.input = null;
  s.sessionId = null;
  s.status = { state: "idle" };
  publishEvent({ kind: "status", slot, status: s.status });
  return { ok: true as const };
}

export async function setClaudePermissionMode({ slot, mode }: { slot: number; mode: ClaudePermissionMode }) {
  const s = getOrCreateSlotState(slot);
  s.permissionMode = mode;
  publishLog(slot, "setPermissionMode", { mode });
  if (!s.q) return { ok: false as const, reason: "not_started" as const };
  try {
    await (s.q as any)?.setPermissionMode?.(mode);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "set_permission_mode_failed" };
  }
}

export function respondToClaudeToolPermission({
  requestId,
  behavior,
  updatedInput,
  updatedPermissions,
  interrupt
}: {
  requestId: string;
  behavior: "allow" | "deny";
  updatedInput?: any;
  updatedPermissions?: any;
  interrupt?: boolean;
}) {
  // Find by requestId across slots.
  for (const s of slots.values()) {
    const pending = s.pendingPermissions.get(requestId);
    if (!pending) continue;
    clearTimeout(pending.timer);
    s.pendingPermissions.delete(requestId);
    publishLog(s.slot, "permission.respond", { requestId, behavior, interrupt, hasUpdatedPermissions: updatedPermissions !== undefined });
    pending.resolve({
      behavior,
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
      ...(interrupt !== undefined ? { interrupt } : {})
    });
    return { ok: true as const };
  }
  return { ok: false as const, reason: "unknown_request_id" as const };
}

export async function disposeAllClaude(reason: string) {
  const slotIds = Array.from(slots.keys());
  for (const slot of slotIds) publishLog(slot, "disposeAll", { reason });
  await Promise.allSettled(slotIds.map((slot) => closeClaude(slot)));
  for (const slot of slotIds) slots.delete(slot);
}

export function disposeAllClaudeSync(reason: string) {
  for (const s of slots.values()) {
    publishLog(s.slot, "disposeAllSync", { reason });
    for (const [id, pending] of s.pendingPermissions.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("claude_closed"));
      s.pendingPermissions.delete(id);
    }
    try {
      if (s.childProc && s.childProc.exitCode === null) s.childProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    s.childProc = null;
    s.q = null;
    s.input = null;
    s.sessionId = null;
    s.status = { state: "idle" };
  }
  slots.clear();
}
