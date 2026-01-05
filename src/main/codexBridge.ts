import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { JsonlStreamParser, type JsonRpcIncoming, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse } from "./codexJsonRpc";

function sanitizeShellEnv(env: Record<string, string | undefined>) {
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  return env;
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
  const merged = Array.from(new Set([currentPath, ...additionalPaths].filter(Boolean))).join(path.delimiter);
  return merged || currentPath;
}

function shQuote(value: string) {
  // Safe for sh/bash/zsh. Example: abc'd -> 'abc'"'"'d'
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function resolveLoginShellCommand(commandLine: string) {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const base = path.basename(shell);
  // fish's `-lc` semantics differ and can emit non-protocol output; keep direct spawn there.
  if (base !== "zsh" && base !== "bash" && base !== "sh") return null;
  return { shell, args: ["-lc", `exec ${commandLine}`] as const };
}

export type CodexRpcEvent =
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "request"; id: number; method: string; params?: unknown }
  | { kind: "stderr"; text: string }
  | { kind: "status"; status: "starting" | "ready" | "exited" | "error"; error?: string };

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

export class CodexBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pendingTimeouts = new Map<number, NodeJS.Timeout>();
  private stdoutParser = new JsonlStreamParser();
  private initializing: Promise<void> | null = null;
  private initialized = false;
  private stuck = false;
  private stderrRing = "";

  constructor(
    private readonly options: {
      clientInfo: { name: string; title: string; version: string };
      onEvent: (event: CodexRpcEvent) => void;
      defaultCwd?: string;
      codexHome?: string;
      codexExecutablePath?: string | null;
    }
  ) {}

  dispose() {
    this.initialized = false;
    this.stuck = false;
    this.flushPendingWithError(new Error("codex_bridge_disposed"));
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }

  private async stopRunningProcess(reason: string) {
    const child = this.proc;
    if (!child || child.exitCode !== null) return;

    const pid = child.pid;
    this.options.onEvent({ kind: "stderr", text: `[codex] stopping app-server (${reason}) pid=${pid}\n` });

    const waitForExit = (timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitedTerm = await waitForExit(1500);
    if (exitedTerm) return;

    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    const exitedKill = await waitForExit(1500);
    if (exitedKill) return;

    // If we still can't stop it, do NOT spawn another process; otherwise we leak dozens of wedged app-servers.
    // This can happen when the child is stuck in an uninterruptible kernel wait (macOS ps shows STAT=UE).
    this.stuck = true;
    const msg = `codex_app_server_stuck:pid=${pid}`;
    this.options.onEvent({ kind: "stderr", text: `[codex] ${msg} (SIGTERM/SIGKILL ignored)\n` });
    throw new Error(msg);
  }

  async ensureStarted(): Promise<void> {
    if (this.stuck) throw new Error("codex_app_server_stuck");
    if (this.proc && this.proc.exitCode === null && this.initialized) {
      // Renderer refresh (webContents reload) will lose its in-memory status.
      // Re-emit "ready" so UI can recover without forcing a re-initialize.
      this.options.onEvent({ kind: "status", status: "ready" });
      return;
    }
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      this.options.onEvent({ kind: "status", status: "starting" });

      const startWithHome = async (codexHome?: string) => {
        // If a previous app-server exists but never became ready, stop it before spawning a new one.
        // Otherwise repeated retries can create many orphaned processes.
        await this.stopRunningProcess("restart");

        this.stderrRing = "";
        this.options.onEvent({
          kind: "stderr",
          text: `[codex] CODEX_HOME=${codexHome || "(default ~/.codex)"}\n`
        });

        const env = sanitizeShellEnv({
          ...process.env,
          PATH: getEnhancedPath(),
          LANG: process.env.LANG || "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8"
        });
        if (codexHome) env.CODEX_HOME = codexHome;

        const codexExe = this.options.codexExecutablePath;
        const codexCommandLine = codexExe ? `${shQuote(codexExe)} app-server` : "codex app-server";

        // NOTE: On macOS, apps launched from GUI often miss shell env vars (API keys, proxies, etc).
        // Starting via a login shell makes the environment closer to what VS Code extension sees.
        const shellCmd = resolveLoginShellCommand(codexCommandLine);
        if (shellCmd) {
          this.options.onEvent({
            kind: "stderr",
            text: `[codex] spawning via login shell: ${shellCmd.shell} ${shellCmd.args.join(" ")}\n`
          });
        }
        const child = shellCmd
          ? spawn(shellCmd.shell, shellCmd.args, {
              cwd: this.options.defaultCwd || process.cwd(),
              env,
              stdio: ["pipe", "pipe", "pipe"]
            })
          : spawn(codexExe || "codex", ["app-server"], {
              cwd: this.options.defaultCwd || process.cwd(),
              env,
              stdio: ["pipe", "pipe", "pipe"]
            });

        this.proc = child;
        this.initialized = false;
        this.stdoutParser = new JsonlStreamParser();

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
        child.stderr.on("data", (chunk: string) => {
          this.stderrRing = (this.stderrRing + chunk).slice(-16_000);
          this.options.onEvent({ kind: "stderr", text: chunk });
        });
        child.on("exit", (code, signal) => {
          this.initialized = false;
          this.proc = null;
          const reason = `codex_exited:${code ?? "null"}:${signal ?? "null"}`;
          this.flushPendingWithError(new Error(reason));
          this.options.onEvent({ kind: "status", status: "exited", error: reason });
        });
        child.on("error", (err) => {
          this.initialized = false;
          this.proc = null;
          this.flushPendingWithError(err instanceof Error ? err : new Error("codex_spawn_error"));
          this.options.onEvent({ kind: "status", status: "error", error: err.message });
        });
      };

      const primary = this.options.codexHome;

      const attempt = async (codexHome?: string) => {
        await startWithHome(codexHome);
        // Some environments (cold start, heavy MCP config, slow disk) can take a while before the server
        // responds to initialize. Keep this generous.
        await this.sendRequest("initialize", { clientInfo: this.options.clientInfo }, { timeoutMs: 30_000 });
        this.notify("initialized");
        this.initialized = true;
        this.options.onEvent({ kind: "status", status: "ready" });
      };

      await attempt(primary);
    })().finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    // Most app-server calls should return quickly; keep a reasonable timeout so the UI
    // doesn't hang forever when the server stops responding.
    return await this.sendRequest(method, params, { timeoutMs: 60_000 });
  }

  private async sendRequest(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    const child = this.proc;
    if (!child) throw new Error("codex_not_running");
    const id = this.nextId;
    this.nextId += 1;

    const payload: JsonRpcRequest = { id, method, ...(typeof params === "undefined" ? {} : { params }) };
    const line = JSON.stringify(payload);

    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${line}\n`, "utf8");
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error("stdin_write_failed"));
      }

      const timeoutMs = typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.pendingTimeouts.delete(id);
          try {
            reject(new Error(`rpc_timeout:${method}`));
          } finally {
            // If initialize times out, the process is likely unhealthy; terminate so a retry can succeed.
            if (method === "initialize") {
              void this.stopRunningProcess("initialize_timeout").catch(() => void 0);
            }
          }
        }, timeoutMs);
        this.pendingTimeouts.set(id, timer);
      }
    });
  }

  notify(method: string, params?: unknown) {
    const child = this.proc;
    if (!child || child.exitCode !== null) return;
    const payload: JsonRpcNotification = { method, ...(typeof params === "undefined" ? {} : { params }) };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      // ignore
    }
  }

  respond(id: number, result?: unknown, error?: { code?: number; message: string; data?: unknown }) {
    const child = this.proc;
    if (!child || child.exitCode !== null) return;

    const payload = error ? ({ id, error } satisfies JsonRpcResponse) : ({ id, result: result ?? {} } satisfies JsonRpcResponse);
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      // ignore
    }
  }

  private handleStdout(chunk: string) {
    const { messages, errors } = this.stdoutParser.feed(chunk);
    for (const err of errors) {
      this.options.onEvent({ kind: "stderr", text: `[codex] failed to parse JSONL: ${err}\n` });
    }
    for (const msg of messages) this.dispatchIncoming(msg);
  }

  private dispatchIncoming(msg: JsonRpcIncoming) {
    if (typeof (msg as any)?.id === "number" && ("result" in (msg as any) || "error" in (msg as any))) {
      const id = (msg as JsonRpcResponse).id;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const timer = this.pendingTimeouts.get(id);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimeouts.delete(id);
      }
      if ("error" in msg && msg.error) pending.reject(new Error(msg.error.message || "rpc_error"));
      else pending.resolve((msg as any).result);
      return;
    }

    if (typeof (msg as any)?.method !== "string") return;
    const method = String((msg as any).method);
    const params = (msg as any).params;

    if (typeof (msg as any)?.id === "number") {
      this.options.onEvent({ kind: "request", id: Number((msg as any).id), method, params });
      return;
    }

    this.options.onEvent({ kind: "notification", method, params });
  }

  private flushPendingWithError(err: Error) {
    for (const [id, pending] of this.pending) {
      pending.reject(err);
      this.pending.delete(id);
    }
    for (const [id, timer] of this.pendingTimeouts) {
      clearTimeout(timer);
      this.pendingTimeouts.delete(id);
    }
  }
}
