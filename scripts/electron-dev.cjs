#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * On Windows, `cross-env ELECTRON_RUN_AS_NODE=` still sets the variable (empty string),
 * which makes Electron run in Node mode. In that mode, `require('electron')` returns
 * the path to the Electron executable instead of the Electron API object, so `app` is undefined.
 *
 * This script spawns Electron with ELECTRON_RUN_AS_NODE removed from the child environment.
 */

function buildChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "electron_run_as_node") {
      delete env[key];
    }
  }
  return env;
}

const electronBinary = require("electron");
const args = process.argv.slice(2);

function killOldXcodingElectron() {
  // Best-effort: kill orphaned XCoding child processes from previous dev runs that didn't exit cleanly.
  // Only targets this repo's bundled project service entry (dist/main/projectService.cjs).
  try {
    const repoRoot = process.cwd();
    const needle = path.join(repoRoot, "dist", "main", "projectService.cjs");
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const victims = [];
    for (const line of lines) {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const cmd = m[3] || "";
      if (ppid !== 1) continue;
      if (!cmd.includes(needle)) continue;
      victims.push(pid);
    }
    for (const pid of victims) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// Default on in dev; set XCODING_DEV_KILL_OLD=0 to disable.
if (process.env.XCODING_DEV_KILL_OLD !== "0") killOldXcodingElectron();

const child = spawn(electronBinary, args.length ? args : ["."], {
  stdio: "inherit",
  env: buildChildEnv()
});

const forwardSignal = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (typeof code === "number") process.exit(code);
  if (signal) process.kill(process.pid, signal);
  process.exit(1);
});
