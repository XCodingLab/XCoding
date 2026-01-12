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

function removeOtherVersions(baseDir, keepDirName) {
  if (!fs.existsSync(baseDir)) return;
  for (const ent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (ent.name === ".gitkeep" || ent.name === "version.txt") continue;
    if (ent.name === keepDirName) continue;
    rmIfExists(path.join(baseDir, ent.name));
  }
}

function getRipgrepDirsForCurrentPlatform() {
  if (process.platform === "darwin") return ["arm64-darwin", "x64-darwin"];
  if (process.platform === "linux") return ["arm64-linux", "x64-linux"];
  if (process.platform === "win32") return ["x64-win32"];
  return [];
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

  const baseOut = path.join(repoRoot(), "assets", "claude-code");
  ensureDir(baseOut);
  removeOtherVersions(baseOut, version);

  const outRoot = path.join(baseOut, version);
  rmIfExists(outRoot);
  ensureDir(outRoot);

  const required = [
    "cli.js",
    "package.json",
    "resvg.wasm",
    "tree-sitter.wasm",
    "tree-sitter-bash.wasm"
  ];

  for (const rel of required) {
    const from = path.join(srcRoot, rel);
    if (!fs.existsSync(from)) throw new Error(`missing_required_file:${rel}`);
    copyRecursive(from, path.join(outRoot, rel));
  }

  // Copy only the ripgrep binaries for the current OS (and common macOS/Linux arches),
  // to avoid bundling all platforms into the packaged app.
  const rgRoot = path.join(srcRoot, "vendor", "ripgrep");
  const rgOut = path.join(outRoot, "vendor", "ripgrep");
  if (!fs.existsSync(rgRoot)) throw new Error("missing_required_dir:vendor/ripgrep");
  ensureDir(rgOut);
  copyRecursive(path.join(rgRoot, "COPYING"), path.join(rgOut, "COPYING"));
  const rgDirs = getRipgrepDirsForCurrentPlatform();
  if (!rgDirs.length) throw new Error(`unsupported_platform_for_ripgrep:${process.platform}`);
  const copiedDirs = [];
  for (const dir of rgDirs) {
    const from = path.join(rgRoot, dir);
    if (!fs.existsSync(from)) continue;
    copyRecursive(from, path.join(rgOut, dir));
    copiedDirs.push(dir);
  }
  if (!copiedDirs.length) {
    throw new Error(`missing_ripgrep_bins_for_platform:${process.platform}`);
  }

  fs.writeFileSync(path.join(baseOut, "version.txt"), `${version}\n`, "utf8");

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
  console.log(`[copy:claude-code] Files: ${copied.length} (ripgrep: ${copiedDirs.join(", ")})`);
}

main();
