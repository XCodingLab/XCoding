#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function chmodIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    if ((mode & 0o111) !== 0) return false;
    fs.chmodSync(filePath, 0o755);
    return true;
  } catch {
    return false;
  }
}

function findSpawnHelpers(root) {
  const results = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".bin") continue;
        queue.push(full);
        continue;
      }
      if (entry.isFile() && entry.name === "spawn-helper") results.push(full);
    }
  }
  return results;
}

function main() {
  const nodeModules = path.join(process.cwd(), "node_modules");
  if (!fs.existsSync(nodeModules)) return;

  const candidates = findSpawnHelpers(nodeModules);
  if (!candidates.length) return;

  let changed = 0;
  for (const filePath of candidates) {
    if (!filePath.includes(`${path.sep}node-pty${path.sep}`)) continue;
    if (chmodIfNeeded(filePath)) changed++;
  }

  if (changed) {
    console.log(`[fix-node-pty-perms] chmod +x applied to ${changed} spawn-helper file(s)`);
  }
}

main();

