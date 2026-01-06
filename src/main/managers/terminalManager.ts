import { homedir } from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import { broadcast } from "../app/windowManager";

type TerminalSession = {
  id: string;
  kind: "pty" | "proc";
  pty?: IPty;
  proc?: ChildProcessWithoutNullStreams;
  buffer?: string;
};

const terminalSessions = new Map<string, TerminalSession>();

function appendTerminalBuffer(sessionId: string, chunk: string) {
  const s = terminalSessions.get(sessionId);
  if (!s) return;
  const next = (s.buffer ?? "") + chunk;
  // Keep ~200KB of recent output to allow UI remount without going blank.
  const MAX = 200_000;
  s.buffer = next.length > MAX ? next.slice(next.length - MAX) : next;
}

function sanitizeShellEnv(env: Record<string, string | undefined>) {
  // nvm warns (and can refuse to work) when npm_config_prefix is set (often set by pnpm global prefix).
  // We sanitize the terminal environment to be closer to a "login shell" and avoid tool conflicts.
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  return env;
}

function adjustArgsForShell(shell: string, args: string[]): string[] {
  const base = path.basename(shell).toLowerCase();
  if (base.includes("zsh") || base.includes("bash")) return args;
  if (base.includes("fish")) return ["-l", ...args.filter((a) => a !== "-l")];
  if (base.includes("pwsh") || base.includes("powershell")) return [];
  return args;
}

function getEnhancedPath(): string {
  const currentPath = process.env.PATH || "";
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  // Include common toolchain paths.
  const additionalPaths = [
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
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

export function createTerminal({ cwd }: { cwd: string }) {
  const id = `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const resolvedCwd = fs.existsSync(cwd) ? cwd : process.cwd();

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
          cwd: resolvedCwd,
          env
        });
        terminalSessions.set(id, { id, kind: "pty", pty: ptyProcess, buffer: "" });
        ptyProcess.onData((data) => {
          appendTerminalBuffer(id, data);
          broadcast("terminal:data", { sessionId: id, data });
        });
        ptyProcess.onExit(() => terminalSessions.delete(id));
        return { ok: true as const, sessionId: id, cwd: resolvedCwd, shell: c.label, kind: "pty" as const };
      } catch (e) {
        lastError = e;
      }
    }

    // Fallback: non-PTY process-based terminal (limited interactivity but works when pty is unavailable).
    const fallbackShell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL && fs.existsSync(process.env.SHELL)
          ? process.env.SHELL
          : fs.existsSync("/bin/zsh")
            ? "/bin/zsh"
            : "/bin/bash";
    const proc = spawn(fallbackShell, [], {
      cwd: resolvedCwd,
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
    return {
      ok: true as const,
      sessionId: id,
      cwd: resolvedCwd,
      shell: `proc:${fallbackShell}`,
      kind: "proc" as const,
      lastError: String((lastError as any)?.message ?? lastError ?? "")
    };
  } catch (e) {
    const err = e as any;
    const extra = typeof err?.errno === "number" ? ` (errno=${err.errno})` : "";
    const message = e instanceof Error ? e.message : "spawn_failed";
    return { ok: false as const, reason: `${message}${extra}`, cwd: resolvedCwd };
  }
}

export function terminalWrite(sessionId: string, data: string) {
  const s = terminalSessions.get(sessionId);
  if (!s) return { ok: false as const };
  if (s.kind === "pty" && s.pty) s.pty.write(data);
  if (s.kind === "proc" && s.proc) s.proc.stdin.write(data);
  return { ok: true as const };
}

export function terminalResize(sessionId: string, cols: number, rows: number) {
  const s = terminalSessions.get(sessionId);
  if (!s) return { ok: false as const };
  if (s.kind === "pty" && s.pty) s.pty.resize(cols, rows);
  return { ok: true as const };
}

export function terminalGetBuffer(sessionId: string, maxBytes?: number) {
  const s = terminalSessions.get(sessionId);
  if (!s) return { ok: false as const };
  const buf = s.buffer ?? "";
  const max = typeof maxBytes === "number" ? Math.max(1_000, Math.min(500_000, maxBytes)) : 200_000;
  const out = buf.length > max ? buf.slice(buf.length - max) : buf;
  return { ok: true as const, data: out };
}

export function terminalDispose(sessionId: string) {
  const s = terminalSessions.get(sessionId);
  if (!s) return { ok: true as const };
  try {
    if (s.kind === "pty" && s.pty) s.pty.kill();
    if (s.kind === "proc" && s.proc) s.proc.kill();
  } catch {
    // ignore
  } finally {
    terminalSessions.delete(sessionId);
  }
  return { ok: true as const };
}

export function disposeAllTerminals() {
  for (const session of terminalSessions.values()) {
    try {
      if (session.kind === "pty" && session.pty) session.pty.kill();
      if (session.kind === "proc" && session.proc) session.proc.kill();
    } catch {
      // ignore
    }
  }
  terminalSessions.clear();
}

