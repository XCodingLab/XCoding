#!/usr/bin/env node

const net = require("node:net");
const { spawn } = require("node:child_process");

async function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickPort(start, end) {
  for (let port = start; port <= end; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(port);
    if (free) return port;
  }
  return null;
}

async function main() {
  const preferredPort = Number(process.env.VITE_PORT) || 5173;
  const port = (await pickPort(preferredPort, preferredPort + 50)) ?? preferredPort;
  const devServerUrl = process.env.XCODING_DEV_SERVER_URL || `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    VITE_PORT: String(port),
    XCODING_DEV_SERVER_URL: devServerUrl
  };

  const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    "exec",
    "concurrently",
    "--kill-others-on-fail",
    "vite",
    "pnpm run main:watch",
    `wait-on ${devServerUrl} file:dist/main/main.cjs file:dist/main/preload.cjs && pnpm run electron:dev`
  ];

  const child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    if (typeof code === "number") process.exit(code);
    if (signal) process.kill(process.pid, signal);
    process.exit(1);
  });
}

void main();
