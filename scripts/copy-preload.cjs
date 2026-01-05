#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const src = path.join(repoRoot, "src", "main", "preload.cjs");
const destDir = path.join(repoRoot, "dist", "main");
const dest = path.join(destDir, "preload.cjs");

fs.mkdirSync(destDir, { recursive: true });

try {
  const st = fs.statSync(dest);
  if (st.isDirectory()) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
} catch {
  // ignore
}

fs.copyFileSync(src, dest);
