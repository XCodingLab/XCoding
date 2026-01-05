#!/usr/bin/env node

const { spawn } = require("node:child_process");

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
