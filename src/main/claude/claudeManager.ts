import { app } from "electron";
import { broadcast } from "../app/windowManager";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AccountInfo, ModelInfo, Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { resolveBundledClaudeCode } from "./claudeExecutable";
import { computeProposedDiffPreview, type ProposedDiffPreview } from "./diff/proposedDiffPreview";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
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
  preview?: ProposedDiffPreview | { loading: true } | { error: string };
};

type PendingPermission = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  abortPreview?: () => void;
};

type SlotState = {
  slot: number;
  projectRootPath: string;
  sessionId: string | null;
  permissionMode: ClaudePermissionMode;
  q: Query | null;
  input: PushableAsyncIterable<SDKUserMessage> | null;
  childProc: ChildProcess | null;
  run:
    | null
    | {
        runId: string;
        sessionId: string | null;
        abortController: AbortController;
        q: Query;
        startedAt: number;
      };
  pendingPermissions: Map<string, PendingPermission>;
  status: ClaudeStatus;
  forkSession: boolean;
  sessionIdWaiters: Array<(sessionId: string) => void>;
  meta: {
    supportedCommands: SlashCommand[] | null;
    supportedModels: ModelInfo[] | null;
    accountInfo: AccountInfo | null;
    currentModel: string | null;
    maxThinkingTokens: number | null;
    appliedPermissionMode: ClaudePermissionMode | null;
  };
};

const slots = new Map<number, SlotState>();
const runningBySessionId = new Map<string, { slot: number; runId: string }>();

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
    run: null,
    pendingPermissions: new Map(),
    status: { state: "idle" },
    forkSession: false,
    sessionIdWaiters: [],
    meta: {
      supportedCommands: null,
      supportedModels: null,
      accountInfo: null,
      currentModel: null,
      maxThinkingTokens: null,
      appliedPermissionMode: null
    }
  };
  slots.set(slot, next);
  return next;
}

function makeRequestId() {
  return `claude-req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeRunId() {
  return `claude-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function publishEvent(event: any) {
  broadcast("claude:event", event);
}

function publishRequest(req: ClaudeToolPermissionRequest) {
  broadcast("claude:request", req);
}

function publishLog(slot: number, message: string, data?: any) {
  publishEvent({ kind: "log", slot, message, data });
  // Renderer-side logging is gated by isDev; additionally mirror to main stdout when debugging,
  // so users can inspect logs even if DevTools is unavailable.
  if (shouldEnableClaudeCliDebugArgs() || process.env.XCODING_CLAUDE_DEBUG_MAIN === "1") {
    try {
      // Avoid dumping huge objects accidentally.
      const payload = data === undefined ? "" : data;
      console.log(`[Claude][slot ${slot}] ${message}`, payload);
    } catch {
      // ignore
    }
  }
}

function shouldEnableClaudeCliDebugArgs() {
  const v = typeof process.env.XCODING_CLAUDE_DEBUG === "string" ? process.env.XCODING_CLAUDE_DEBUG.trim() : "";
  if (!v || v === "0") return false;
  // Always require explicit opt-in (dev or packaged) to avoid noisy logs and accidental leakage in stderr.
  return true;
}

function shouldMirrorClaudeCliStderrToTerminal() {
  const v = process.env.XCODING_CLAUDE_DEBUG;
  if (!v || v === "0") return false;
  return true;
}

function clearPendingPermissions(slot: number, s: SlotState, reason: string) {
  for (const [id, pending] of s.pendingPermissions.entries()) {
    clearTimeout(pending.timer);
    pending.abortPreview?.();
    pending.reject(new Error(reason));
    s.pendingPermissions.delete(id);
  }
  publishLog(slot, "permission.pending_cleared", { reason });
}

function normalizePromptContent(content: unknown): string | Array<{ type: string; [k: string]: any }> {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content as any;
  return String(content ?? "");
}

function looksLikeInterruptError(message: string) {
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("interrupted") ||
    m.includes("abort") ||
    m.includes("aborted") ||
    m.includes("operation aborted") ||
    m.includes("process aborted") ||
    m.includes("request ended without sending any chunks")
  );
}

function scheduleKillChild(slot: number, child: ChildProcess | null, delayMs: number, reason: string) {
  if (!child) return null;
  if (child.exitCode !== null) return null;
  const timer = setTimeout(() => {
    try {
      if (child.exitCode === null) {
        publishLog(slot, "claude_code_process.kill", { reason });
        child.kill("SIGTERM");
      }
    } catch {
      // ignore
    }
  }, delayMs);
  return timer;
}

function safeKill(child: ChildProcess | null) {
  if (!child) return;
  try {
    if (child.exitCode === null) child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

function redactClaudeCliStderr(text: string) {
  // Debug output can include API keys/tokens (e.g. env dumps). Redact by default.
  if (process.env.XCODING_CLAUDE_DEBUG_REDACT === "0") return text;

  let out = text;
  out = out.replace(/\bctx7sk-[0-9a-f-]{20,}\b/gi, "ctx7sk-***");
  out = out.replace(/\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g, (m) => `${m.slice(0, 13)}***`);
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-***");
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1***");
  out = out.replace(/("(?:[^"\\]|\\.)*?(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD)(?:[^"\\]|\\.)*?"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2");
  out = out.replace(/(\bAuthorization:\s*)([^\s]+)/gi, "$1<redacted>");
  return out;
}

function normalizeSlashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((c: any) => ({
      name: String(c?.name ?? ""),
      description: String(c?.description ?? ""),
      argumentHint: String(c?.argumentHint ?? "")
    }))
    .filter((c) => c.name);
}

function normalizeModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((m: any) => ({
      value: String(m?.value ?? ""),
      displayName: String(m?.displayName ?? ""),
      description: String(m?.description ?? "")
    }))
    .filter((m) => m.value);
}

function normalizeAccountInfo(value: unknown): AccountInfo {
  if (!value || typeof value !== "object") return {};
  const v = value as any;
  return {
    email: typeof v.email === "string" ? v.email : undefined,
    organization: typeof v.organization === "string" ? v.organization : undefined,
    subscriptionType: typeof v.subscriptionType === "string" ? v.subscriptionType : undefined,
    tokenSource: typeof v.tokenSource === "string" ? v.tokenSource : undefined,
    apiKeySource: typeof v.apiKeySource === "string" ? v.apiKeySource : undefined
  };
}

function makeIdeSystemPromptAppend(projectRootPath: string) {
  return `\n\n# XCoding IDE Context\n\nYou are running inside the XCoding desktop IDE.\n\n## Project Root\nProject root: ${projectRootPath}\n\n## Code References in Text\nWhen referencing files or code locations, use clickable markdown links with project-relative hrefs:\n- File: [src/foo.ts](src/foo.ts)\n- Line: [src/foo.ts:42](src/foo.ts#L42)\n- Range: [src/foo.ts:42-51](src/foo.ts#L42-L51)\n\n## User Selection Context\nThe user's current editor selection may be provided separately by the host IDE.\n`;
}

// Keep these strings exactly aligned with the official VS Code plugin webview build.
const OFFICIAL_DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const OFFICIAL_DENY_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ";
const OFFICIAL_STAY_IN_PLAN_MESSAGE = "User chose to stay in plan mode and continue planning";

function isWriteToolName(toolName: unknown): toolName is "Write" | "Edit" | "MultiEdit" {
  const name = String(toolName ?? "");
  return name === "Write" || name === "Edit" || name === "MultiEdit";
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
    let args = Array.isArray(options?.args) ? options.args : [];
    if (shouldEnableClaudeCliDebugArgs()) {
      const hasDebug =
        args.some((a: any) => String(a ?? "") === "--debug" || String(a ?? "") === "-d") ||
        args.some((a: any) => String(a ?? "").startsWith("--debug=") || String(a ?? "").startsWith("-d="));
      const hasDebugToStderr = args.some((a: any) => String(a ?? "") === "--debug-to-stderr" || String(a ?? "") === "-d2e");
      const next = args.slice();
      if (!hasDebugToStderr) next.unshift("--debug-to-stderr");
      if (!hasDebug) {
        const filter = typeof process.env.XCODING_CLAUDE_DEBUG_FILTER === "string" ? process.env.XCODING_CLAUDE_DEBUG_FILTER.trim() : "";
        if (filter) next.unshift("--debug", filter);
        else next.unshift("--debug");
      }
      args = next;
    }
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
      const text = redactClaudeCliStderr(buf.toString("utf8"));
      publishEvent({ kind: "stderr", slot, text });
      if (shouldMirrorClaudeCliStderrToTerminal()) {
        try {
          process.stderr.write(text);
        } catch {
          // ignore
        }
      }
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

  if (s.run) {
    publishLog(slot, "ensureClaudeStarted.busy", { runId: s.run.runId, sessionId: s.run.sessionId });
    return { ok: true as const, sessionId: s.sessionId, permissionMode: s.permissionMode };
  }

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
      s.meta.supportedCommands = null;
      s.meta.supportedModels = null;
      s.meta.accountInfo = null;
      s.meta.currentModel = null;
      s.meta.maxThinkingTokens = null;
      s.meta.appliedPermissionMode = null;
    } else {
      if (requestedMode) {
        if (s.meta.appliedPermissionMode !== requestedMode) {
          try {
            await (s.q as any)?.setPermissionMode?.(requestedMode);
            s.meta.appliedPermissionMode = requestedMode;
            publishLog(slot, "ensureClaudeStarted.setPermissionMode", { mode: requestedMode });
          } catch (e) {
            publishLog(slot, "ensureClaudeStarted.setPermissionMode_failed", { mode: requestedMode, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      return { ok: true as const, sessionId: s.sessionId, permissionMode: s.permissionMode };
    }
  }

  if (requestedSessionId) s.sessionId = requestedSessionId;

  if (s.q) {
    if (requestedMode) {
      if (s.meta.appliedPermissionMode !== requestedMode) {
        try {
          await (s.q as any)?.setPermissionMode?.(requestedMode);
          s.meta.appliedPermissionMode = requestedMode;
          publishLog(slot, "ensureClaudeStarted.setPermissionMode", { mode: requestedMode });
        } catch (e) {
          publishLog(slot, "ensureClaudeStarted.setPermissionMode_failed", { mode: requestedMode, error: e instanceof Error ? e.message : String(e) });
        }
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
      extraArgs: { "enable-auth-status": null },
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
      canUseTool: makeCanUseTool(slot, s)
    }
  });

  s.q = q as unknown as Query;
  s.meta.appliedPermissionMode = s.permissionMode;

  // Start streaming asynchronously.
  (async () => {
    try {
      for await (const ev of q) {
        if (ev && typeof ev === "object" && (ev as any).type === "system" && (ev as any).subtype === "init") {
          const nextSessionId = typeof (ev as any).session_id === "string" ? (ev as any).session_id : null;
          const initPermissionMode = typeof (ev as any).permissionMode === "string" ? String((ev as any).permissionMode) : null;
          const initModel = typeof (ev as any).model === "string" ? String((ev as any).model) : null;
          if (initModel) s.meta.currentModel = initModel;
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

export async function runClaudeTurn({
  slot,
  projectRootPath,
  sessionId,
  permissionMode,
  forkSession,
  content,
  isSynthetic
}: {
  slot: number;
  projectRootPath: string;
  sessionId?: string | null;
  permissionMode?: ClaudePermissionMode;
  forkSession?: boolean;
  content: unknown;
  isSynthetic?: boolean;
}) {
  const s = getOrCreateSlotState(slot);
  const root = String(projectRootPath || "").trim();
  if (!root) return { ok: false as const, reason: "missing_projectRootPath" as const };

  const requestedMode = typeof permissionMode === "string" ? permissionMode : null;
  const requestedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;

  if (s.run) {
    publishLog(slot, "run.busy_slot", { runId: s.run.runId, sessionId: s.run.sessionId });
    return { ok: false as const, reason: "slot_busy" as const };
  }
  if (requestedSessionId && runningBySessionId.has(requestedSessionId)) {
    const cur = runningBySessionId.get(requestedSessionId)!;
    publishLog(slot, "run.busy_session", { sessionId: requestedSessionId, heldBy: cur });
    return { ok: false as const, reason: "session_busy" as const };
  }

  s.projectRootPath = root;
  if (requestedMode) s.permissionMode = requestedMode;
  s.forkSession = typeof forkSession === "boolean" ? Boolean(forkSession) : false;
  if (requestedSessionId) s.sessionId = requestedSessionId;

  const payload = normalizePromptContent(content);
  if (typeof payload === "string" && !payload.trim()) return { ok: false as const, reason: "empty" as const };
  if (Array.isArray(payload) && payload.length === 0) return { ok: false as const, reason: "empty" as const };

  const bundled = resolveBundledClaudeCode();
  if (!bundled) return { ok: false as const, reason: "claude_code_bundle_missing" as const };

  const runId = makeRunId();
  const startedAt = Date.now();

  const boundSessionId = requestedSessionId;
  if (boundSessionId) runningBySessionId.set(boundSessionId, { slot, runId });

  publishLog(slot, "run.begin", {
    runId,
    resumeSessionId: boundSessionId,
    permissionMode: s.permissionMode,
    forkSession: s.forkSession,
    isSynthetic: isSynthetic === true,
    kind: typeof payload === "string" ? "text" : "blocks",
    length: typeof payload === "string" ? payload.length : Array.isArray(payload) ? payload.length : undefined
  });

  clearPendingPermissions(slot, s, "run_begin");
  s.status = { state: "starting" };
  publishEvent({ kind: "status", slot, status: s.status });

  const { query } = await getClaudeAgentSdk();
  const q = query({
    prompt: payload as any,
    options: {
      cwd: s.projectRootPath || process.cwd(),
      includePartialMessages: true,
      extraArgs: { "enable-auth-status": null },
      enableFileCheckpointing: true,
      settingSources: ["user", "project", "local"],
      allowDangerouslySkipPermissions: true,
      permissionMode: s.permissionMode,
      ...(boundSessionId
        ? {
            resume: boundSessionId,
            continueConversation: true,
            ...(s.forkSession ? { forkSession: true } : {})
          }
        : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: makeIdeSystemPromptAppend(s.projectRootPath) },
      spawnClaudeCodeProcess: spawnClaudeCodeProcessForSlot(slot),
      pathToClaudeCodeExecutable: bundled.cliJsPath as any,
      executable: process.execPath as any,
      stderr: (err) => publishEvent({ kind: "stderr", slot, text: String(err ?? "") }),
      canUseTool: makeCanUseTool(slot, s)
    }
  });

  s.run = { runId, sessionId: boundSessionId, abortController: new AbortController(), q: q as unknown as Query, startedAt };

  void (async () => {
    let firstChunkAt: number | null = null;
    let effectiveSessionId: string | null = boundSessionId;
    try {
      for await (const ev of q as any) {
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
          publishLog(slot, "run.first_chunk", { runId, ms: firstChunkAt - startedAt });
        }
        if (ev && typeof ev === "object" && (ev as any).type === "system" && (ev as any).subtype === "init") {
          const nextSessionId = typeof (ev as any).session_id === "string" ? (ev as any).session_id : null;
          if (nextSessionId && nextSessionId !== s.sessionId) {
            s.sessionId = nextSessionId;
            effectiveSessionId = nextSessionId;
            publishLog(slot, "session.init", { runId, sessionId: nextSessionId });
            publishEvent({ kind: "session", slot, sessionId: nextSessionId });
          }
        }
        publishEvent({ kind: "stream", slot, event: ev });
      }
      publishLog(slot, "run.done", { runId, sessionId: effectiveSessionId, ms: Date.now() - startedAt });
      s.status = { state: "idle" };
      publishEvent({ kind: "status", slot, status: s.status });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "claude_run_error";
      if (looksLikeInterruptError(msg)) {
        publishLog(slot, "run.interrupted", { runId, ms: Date.now() - startedAt });
        s.status = { state: "idle" };
        publishEvent({ kind: "status", slot, status: s.status });
      } else {
        publishLog(slot, "run.error", { runId, error: msg, ms: Date.now() - startedAt });
        s.status = { state: "error", error: msg };
        publishEvent({ kind: "status", slot, status: s.status });
      }
    } finally {
      clearPendingPermissions(slot, s, "run_end");
      try {
        await (q as any)?.return?.();
      } catch {
        // ignore
      }
      const held = effectiveSessionId || boundSessionId;
      if (held) {
        const cur = runningBySessionId.get(held);
        if (cur && cur.runId === runId) runningBySessionId.delete(held);
      }
      if (s.run?.runId === runId) s.run = null;
      s.forkSession = false;
      publishLog(slot, "run.end", { runId });
    }
  })();

  return { ok: true as const, sessionId: boundSessionId, permissionMode: s.permissionMode };
}

export async function getClaudeSupportedCommands(slot: number) {
  const s = getOrCreateSlotState(slot);
  if (s.meta.supportedCommands) return { ok: true as const, commands: s.meta.supportedCommands };
  if (!s.q) return { ok: false as const, reason: "not_started" as const };
  try {
    const raw = await (s.q as any)?.supportedCommands?.();
    const commands = normalizeSlashCommands(raw);
    s.meta.supportedCommands = commands;
    return { ok: true as const, commands };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "supported_commands_failed" };
  }
}

export async function getClaudeSupportedModels(slot: number) {
  const s = getOrCreateSlotState(slot);
  if (s.meta.supportedModels) return { ok: true as const, models: s.meta.supportedModels };
  if (!s.q) return { ok: false as const, reason: "not_started" as const };
  try {
    const raw = await (s.q as any)?.supportedModels?.();
    const models = normalizeModels(raw);
    s.meta.supportedModels = models;
    return { ok: true as const, models };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "supported_models_failed" };
  }
}

export async function getClaudeAccountInfo(slot: number) {
  const s = getOrCreateSlotState(slot);
  if (s.meta.accountInfo) return { ok: true as const, accountInfo: s.meta.accountInfo };
  if (!s.q) return { ok: false as const, reason: "not_started" as const };
  try {
    const raw = await (s.q as any)?.accountInfo?.();
    const accountInfo = normalizeAccountInfo(raw);
    s.meta.accountInfo = accountInfo;
    return { ok: true as const, accountInfo };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "account_info_failed" };
  }
}

export async function setClaudeModel({ slot, model }: { slot: number; model?: string }) {
  const s = getOrCreateSlotState(slot);
  if (!s.q) return { ok: false as const, reason: "not_started" as const };
  try {
    const nextModel = typeof model === "string" && model.trim() ? model.trim() : undefined;
    publishLog(slot, "setModel.begin", { model: nextModel ?? "default" });
    await (s.q as any)?.setModel?.(nextModel);
    s.meta.currentModel = nextModel ?? "default";
    publishLog(slot, "setModel.ok", { model: s.meta.currentModel });
    return { ok: true as const };
  } catch (e) {
    publishLog(slot, "setModel.error", { model, error: e instanceof Error ? e.message : String(e) });
    return { ok: false as const, reason: e instanceof Error ? e.message : "set_model_failed" };
  }
}

export async function setClaudeMaxThinkingTokens({ slot, maxThinkingTokens }: { slot: number; maxThinkingTokens: number | null }) {
  const s = getOrCreateSlotState(slot);
  if (!s.q) return { ok: false as const, reason: "not_started" as const };
  try {
    const next =
      maxThinkingTokens === null ? null : Number.isFinite(Number(maxThinkingTokens)) ? Math.max(0, Math.floor(Number(maxThinkingTokens))) : null;
    publishLog(slot, "setMaxThinkingTokens.begin", { maxThinkingTokens: next });
    await (s.q as any)?.setMaxThinkingTokens?.(next);
    s.meta.maxThinkingTokens = next;
    publishLog(slot, "setMaxThinkingTokens.ok", { maxThinkingTokens: s.meta.maxThinkingTokens });
    return { ok: true as const };
  } catch (e) {
    publishLog(slot, "setMaxThinkingTokens.error", { maxThinkingTokens, error: e instanceof Error ? e.message : String(e) });
    return { ok: false as const, reason: e instanceof Error ? e.message : "set_max_thinking_tokens_failed" };
  }
}

function quotePosix(arg: string) {
  // Always quote to avoid shell injection; safe even for simple tokens.
  return `'${String(arg).replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(arg: string) {
  // PowerShell single-quote escaping: ' -> ''
  return `'${String(arg).replace(/'/g, "''")}'`;
}

export function buildClaudeOpenInTerminalCommand({
  slot,
  resumeSessionId,
  initialInput,
  extraArgs
}: {
  slot: number;
  resumeSessionId?: string | null;
  initialInput?: string | null;
  extraArgs?: string[];
}) {
  const bundled = resolveBundledClaudeCode();
  if (!bundled) return { ok: false as const, reason: "claude_code_bundle_missing" as const };

  const execPath = resolveRunAsNodeExecutablePath();
  const args: string[] = [bundled.cliJsPath];
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs.map((a) => String(a)));
  const sid = typeof resumeSessionId === "string" && resumeSessionId.trim() ? resumeSessionId.trim() : null;
  if (sid) args.push("--resume", sid);

  const envPairs: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "xcoding-terminal",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_INSTALLATION_CHECKS: "1"
  };

  const platform = process.platform;
  let launchLine = "";
  if (platform === "win32") {
    const assigns = Object.entries(envPairs)
      .map(([k, v]) => `$env:${k}=${quotePowerShell(v)};`)
      .join(" ");
    const exe = quotePowerShell(execPath);
    const argv = args.map(quotePowerShell).join(" ");
    launchLine = `${assigns} & ${exe} ${argv}`;
  } else {
    const assigns = Object.entries(envPairs)
      .map(([k, v]) => `${k}=${quotePosix(v)}`)
      .join(" ");
    const exe = quotePosix(execPath);
    const argv = args.map(quotePosix).join(" ");
    launchLine = `${assigns} ${exe} ${argv}`;
  }

  const lines = [launchLine];
  const input = typeof initialInput === "string" ? initialInput.trim() : "";
  if (input) lines.push(input);
  return { ok: true as const, command: `${lines.join("\n")}\n`, slot, claudeCodeVersion: bundled.version };
}

export async function sendClaudeUserMessage({ slot, content, isSynthetic }: { slot: number; content: unknown; isSynthetic?: boolean }) {
  const s = getOrCreateSlotState(slot);
  if (!s.input || !s.q) {
    publishLog(slot, "sendUserMessage.not_started");
    return { ok: false as const, reason: "not_started" as const };
  }
  const synthetic = isSynthetic === true;
  const payload = content as any;
  if (typeof payload === "string") {
    const text = String(payload ?? "");
    if (!text.trim()) return { ok: false as const, reason: "empty" as const };
    publishLog(slot, "sendUserMessage", { kind: "text", length: text.length });
    s.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(synthetic ? { isSynthetic: true } : {}),
      session_id: s.sessionId || ""
    } as any);
    return { ok: true as const };
  }

  if (!Array.isArray(payload)) return { ok: false as const, reason: "invalid_content" as const };
  if (payload.length === 0) return { ok: false as const, reason: "empty" as const };

  publishLog(slot, "sendUserMessage", { kind: "blocks", blocks: payload.length });
  s.input.push({
    type: "user",
    message: { role: "user", content: payload },
    parent_tool_use_id: null,
    ...(synthetic ? { isSynthetic: true } : {}),
    session_id: s.sessionId || ""
  } as any);
  return { ok: true as const };
}

function makeCanUseTool(slot: number, s: SlotState) {
  return async (toolName: any, toolInput: any, meta: any) => {
    const requestId = makeRequestId();

    const hasFilePath = toolInput && typeof (toolInput as any).file_path === "string";
    const isFileTool = hasFilePath && (isWriteToolName(toolName) || String(toolName ?? "") === "Read");
    if (isFileTool) {
      const root = path.resolve(s.projectRootPath || process.cwd());
      const raw = String((toolInput as any).file_path ?? "").trim();
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
      if (!(abs === root || abs.startsWith(root + path.sep))) {
        publishLog(slot, "permission.blockedPath", { requestId, toolName: String(toolName ?? ""), abs, root });
        return {
          behavior: "deny",
          message: OFFICIAL_DENY_WITH_REASON_PREFIX + "file_path must be within projectRootPath",
          interrupt: true
        } as any;
      }
    }

    if (s.permissionMode === "bypassPermissions") {
      publishLog(slot, "permission.autoAllow", { mode: s.permissionMode, toolName: String(toolName ?? "") });
      return { behavior: "allow", updatedInput: toolInput } as any;
    }

    let abortPreview: (() => void) | undefined;
    const wantsPreview = isWriteToolName(toolName) && toolInput && typeof (toolInput as any).file_path === "string";
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
      toolUseId: meta?.toolUseID ?? meta?.tool_use_id,
      ...(wantsPreview ? { preview: { loading: true } } : {})
    });

    if (wantsPreview) {
      const controller = new AbortController();
      abortPreview = () => controller.abort();
      const startedAt = Date.now();
      void (async () => {
        try {
          const preview = await computeProposedDiffPreview({
            projectRootPath: s.projectRootPath || process.cwd(),
            toolName: String(toolName) as any,
            toolInput,
            signal: controller.signal
          });
          publishLog(slot, "permission.preview.ok", { requestId, relPath: preview.relPath, ms: Date.now() - startedAt });
          publishRequest({
            requestId,
            slot,
            sessionId: s.sessionId || "",
            toolName: String(toolName ?? ""),
            toolInput,
            suggestions: meta?.suggestions,
            toolUseId: meta?.toolUseID ?? meta?.tool_use_id,
            preview
          });
        } catch (e) {
          if (controller.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          publishLog(slot, "permission.preview.error", { requestId, error: msg, ms: Date.now() - startedAt });
          publishRequest({
            requestId,
            slot,
            sessionId: s.sessionId || "",
            toolName: String(toolName ?? ""),
            toolInput,
            suggestions: meta?.suggestions,
            toolUseId: meta?.toolUseID ?? meta?.tool_use_id,
            preview: { error: msg }
          });
        }
      })();
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = s.pendingPermissions.get(requestId);
        pending?.abortPreview?.();
        s.pendingPermissions.delete(requestId);
        resolve({
          behavior: "deny",
          message: OFFICIAL_DENY_WITH_REASON_PREFIX + "Timed out waiting for permission response",
          interrupt: true
        });
      }, 120_000);
      s.pendingPermissions.set(requestId, { resolve, reject, timer, ...(abortPreview ? { abortPreview } : {}) });
    });
  };
}

export async function interruptClaude(slot: number) {
  const s = getOrCreateSlotState(slot);
  publishLog(slot, "interrupt");
  if (s.run) {
    publishLog(slot, "interrupt.run", { runId: s.run.runId, sessionId: s.run.sessionId });
    try {
      await (s.run.q as any)?.interrupt?.();
    } catch {
      // ignore
    }
    // Align with official VS Code plugin: do not kill the process on interrupt; let the query handle it.
    // As a safety net, only SIGTERM if the process doesn't exit after a long grace period.
    scheduleKillChild(slot, s.childProc, 8000, "interrupt_timeout");
    return { ok: true as const };
  }
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
  clearPendingPermissions(slot, s, "claude_closed");
  if (s.run) {
    const runId = s.run.runId;
    const sid = s.run.sessionId;
    publishLog(slot, "close.run", { runId, sessionId: sid });
    try {
      await (s.run.q as any)?.interrupt?.();
    } catch {
      // ignore
    }
    try {
      await (s.run.q as any)?.return?.();
    } catch {
      // ignore
    }
    scheduleKillChild(slot, s.childProc, 1500, "close_timeout");
    if (sid) {
      const cur = runningBySessionId.get(sid);
      if (cur && cur.runId === runId) runningBySessionId.delete(sid);
    }
    s.run = null;
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
    s.meta.appliedPermissionMode = mode;
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
  message,
  interrupt
}: {
  requestId: string;
  behavior: "allow" | "deny";
  updatedInput?: any;
  updatedPermissions?: any;
  message?: string;
  interrupt?: boolean;
}) {
  // Find by requestId across slots.
  for (const s of slots.values()) {
    const pending = s.pendingPermissions.get(requestId);
    if (!pending) continue;
    clearTimeout(pending.timer);
    pending.abortPreview?.();
    s.pendingPermissions.delete(requestId);
    publishLog(s.slot, "permission.respond", { requestId, behavior, interrupt, hasUpdatedPermissions: updatedPermissions !== undefined });
    const effectiveMessage = behavior === "deny" && message === undefined ? OFFICIAL_DENY_MESSAGE : message;
    pending.resolve({
      behavior,
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
      ...(effectiveMessage !== undefined ? { message: effectiveMessage } : {}),
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
      pending.abortPreview?.();
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
