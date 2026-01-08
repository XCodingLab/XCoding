/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function repoRoot() {
  return process.cwd();
}

function readVersionFromNodeModules() {
  const pkgPath = path.join(repoRoot(), "node_modules", "@anthropic-ai", "claude-code", "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error(`missing_dependency:@anthropic-ai/claude-code (${pkgPath})`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const v = String(pkg?.version || "").trim();
  if (!v) throw new Error("invalid_version:@anthropic-ai/claude-code");
  return v;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    ensureDir(dest);
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      copyRecursive(path.join(src, ent.name), path.join(dest, ent.name));
    }
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function rmIfExists(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function main() {
  const skip = String(process.env.XCODING_SKIP_CLAUDE_CODE_SETUP || "").trim() === "1";
  if (skip) {
    console.log("[copy:claude-code] Skipped (XCODING_SKIP_CLAUDE_CODE_SETUP=1).");
    return;
  }

  const version = process.env.CLAUDE_CODE_VERSION ? String(process.env.CLAUDE_CODE_VERSION).trim() : readVersionFromNodeModules();
  const srcRoot = path.join(repoRoot(), "node_modules", "@anthropic-ai", "claude-code");
  if (!fs.existsSync(srcRoot)) throw new Error(`missing_source_dir:${srcRoot}`);

  const outRoot = path.join(repoRoot(), "assets", "claude-code", version);
  rmIfExists(outRoot);
  ensureDir(outRoot);

  const required = [
    "cli.js",
    "package.json",
    "resvg.wasm",
    "tree-sitter.wasm",
    "tree-sitter-bash.wasm",
    path.join("vendor", "ripgrep")
  ];

  for (const rel of required) {
    const from = path.join(srcRoot, rel);
    if (!fs.existsSync(from)) throw new Error(`missing_required_file:${rel}`);
    copyRecursive(from, path.join(outRoot, rel));
  }

  fs.writeFileSync(path.join(repoRoot(), "assets", "claude-code", "version.txt"), `${version}\n`, "utf8");

  const copied = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else copied.push(path.relative(outRoot, p));
    }
  };
  walk(outRoot);

  console.log(`[copy:claude-code] Copied @anthropic-ai/claude-code@${version} to ${path.relative(repoRoot(), outRoot)}`);
  console.log(`[copy:claude-code] Files: ${copied.length}`);
}

main();

