/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

function platformArchDir(platform, arch) {
  return `${platform}-${arch}`;
}

function normalizeArch(arch) {
  if (typeof arch === "string") return arch;
  // electron-builder Arch enum values
  if (arch === 0) return "x64";
  if (arch === 1) return "ia32";
  if (arch === 2) return "armv7l";
  if (arch === 3) return "arm64";
  if (arch === 4) return "universal";
  return String(arch);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function ensureExecutable(p) {
  if (process.platform === "win32") return;
  try {
    const st = fs.statSync(p);
    if ((st.mode & 0o111) === 0) fs.chmodSync(p, st.mode | 0o755);
  } catch {
    // ignore
  }
}

function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  return true;
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName; // "darwin" | "win32" | "linux"
  const arch = normalizeArch(context.arch); // "arm64" | "x64" | ...

  const exeName = platform === "win32" ? "codex.exe" : "codex";
  const projectDir = context.packager && context.packager.projectDir ? context.packager.projectDir : process.cwd();
  const from = path.join(
    projectDir,
    "assets",
    "codex",
    "bin",
    platformArchDir(platform, arch),
    exeName
  );

  if (!fs.existsSync(from)) {
    console.warn(`[afterPack] codex binary not found, skipping: ${from}`);
    return;
  }

  let resourcesDir = null;
  if (platform === "darwin") {
    resourcesDir = context.appOutDir
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : null;
  } else {
    resourcesDir = context.appOutDir ? path.join(context.appOutDir, "resources") : null;
  }
  if (!resourcesDir || !fs.existsSync(resourcesDir)) {
    console.warn(`[afterPack] resources dir not found, skipping: ${resourcesDir || "(null)"}`);
    return;
  }

  const toDir = path.join(resourcesDir, "codex", "bin", platformArchDir(platform, arch));
  ensureDir(toDir);
  const to = path.join(toDir, exeName);
  fs.copyFileSync(from, to);
  ensureExecutable(to);
  console.log(`[afterPack] bundled codex: ${to}`);

  // Bundle required license/notice files for the Codex CLI binary (Apache-2.0).
  // Keep them near the bundled binary so they ship with the app.
  const thirdPartyDir = path.join(resourcesDir, "third_party", "codex");
  const projectDirForNotices = projectDir;
  const copiedLicense = copyIfExists(
    path.join(projectDirForNotices, "third_party", "LICENSE.codex-Apache-2.0.txt"),
    path.join(thirdPartyDir, "LICENSE.codex-Apache-2.0.txt")
  );
  const copiedNotice = copyIfExists(
    path.join(projectDirForNotices, "third_party", "NOTICE.codex.txt"),
    path.join(thirdPartyDir, "NOTICE.codex.txt")
  );
  if (copiedLicense || copiedNotice) {
    console.log(
      `[afterPack] bundled codex notices: ${path.join(thirdPartyDir, "LICENSE.codex-Apache-2.0.txt")}, ${path.join(
        thirdPartyDir,
        "NOTICE.codex.txt"
      )}`
    );
  } else {
    console.warn(`[afterPack] codex notices not found in third_party/, skipping`);
  }
};
