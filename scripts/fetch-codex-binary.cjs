/* eslint-disable no-console */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

function platformArchDir(platform, arch) {
  return `${platform}-${arch}`;
}

function isWindows(platform) {
  return platform === "win32";
}

function repoRoot() {
  return process.cwd();
}

function readPinnedVersion() {
  const p = path.join(repoRoot(), "assets", "codex", "version.txt");
  try {
    const v = fs.readFileSync(p, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function assetNameFor(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "codex-aarch64-apple-darwin.tar.gz";
  if (platform === "darwin" && arch === "x64") return "codex-x86_64-apple-darwin.tar.gz";
  if (platform === "linux" && arch === "x64") return "codex-x86_64-unknown-linux-musl.tar.gz";
  if (platform === "linux" && arch === "arm64") return "codex-aarch64-unknown-linux-musl.tar.gz";
  if (platform === "win32" && arch === "x64") return "codex-x86_64-pc-windows-msvc.exe.zip";
  if (platform === "win32" && arch === "arm64") return "codex-aarch64-pc-windows-msvc.exe.zip";
  return null;
}

function githubHeaders() {
  const headers = {
    "User-Agent": "xcoding (fetch-codex-binary)",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeProxyPrefix(raw) {
  const p = String(raw || "").trim();
  if (!p) return "";
  // Support both "https://gh-proxy.com/" and "https://gh-proxy.com"
  return p.endsWith("/") ? p : p + "/";
}

function normalizeProxyFormat(raw) {
  const fmt = String(raw || "").trim().toLowerCase();
  // "prefix" => <proxy>/<url>  (e.g. https://gh-proxy.com/https://github.com/...)
  // "path"   => <proxy>/https://github.com/... (same as prefix; kept for clarity)
  // "query"  => <proxy>?url=<encoded> (not used now)
  if (fmt === "query") return "query";
  return "prefix";
}

function shouldProxyUrl(url) {
  // gh-proxy style proxies often work best for github.com downloads, but can redirect-loop for api.github.com.
  // Default behavior: proxy downloads only (github.com), keep API requests direct.
  const mode = String(process.env.CODEX_GH_PROXY_MODE || "").trim().toLowerCase();
  if (mode === "all") return true;
  if (mode === "api") return url.startsWith("https://api.github.com/");
  if (mode === "downloads") return url.startsWith("https://github.com/") || url.startsWith("https://raw.githubusercontent.com/");
  return url.startsWith("https://github.com/") || url.startsWith("https://raw.githubusercontent.com/");
}

function withProxy(url) {
  const prefix = normalizeProxyPrefix(process.env.CODEX_GH_PROXY || process.env.GH_PROXY || "");
  if (!prefix) return url;
  if (!shouldProxyUrl(url)) return url;
  const format = normalizeProxyFormat(process.env.CODEX_GH_PROXY_FORMAT);
  if (format === "query") return `${prefix}?url=${encodeURIComponent(url)}`;
  // prefix/path style: <proxy>/<full-url>
  return prefix + url;
}

function fetchJson(url, redirectLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(
        withProxy(url),
        {
          headers: githubHeaders()
        },
        (res) => {
          // Follow redirects (some proxies / GitHub flows can redirect).
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectLeft <= 0) {
              reject(new Error("github_api_failed:too_many_redirects"));
              return;
            }
            const nextUrl = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).toString();
            resolve(fetchJson(nextUrl, redirectLeft - 1));
            return;
          }

          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`github_api_failed:${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error("github_api_parse_failed"));
            }
          });
        }
      )
      .on("error", reject);
  });
}

function selectAssetFromRelease(releaseJson, platform, arch) {
  const assets = Array.isArray(releaseJson?.assets) ? releaseJson.assets : [];
  const wanted = assetNameFor(platform, arch);
  if (wanted) {
    const exact = assets.find((a) => a && typeof a === "object" && String(a.name || "") === wanted);
    if (exact && exact.browser_download_url) return { name: String(exact.name), url: String(exact.browser_download_url) };
  }

  // Fallback: heuristic match if naming differs.
  const patterns = [];
  if (platform === "darwin" && arch === "arm64") patterns.push(/aarch64.*apple.*darwin/i, /arm64.*darwin/i);
  if (platform === "darwin" && arch === "x64") patterns.push(/x86_64.*apple.*darwin/i, /x64.*darwin/i);
  if (platform === "linux" && arch === "x64") patterns.push(/x86_64.*linux.*musl/i, /x86_64.*linux/i);
  if (platform === "linux" && arch === "arm64") patterns.push(/aarch64.*linux.*musl/i, /arm64.*linux/i, /aarch64.*linux/i);
  if (platform === "win32" && arch === "x64") patterns.push(/windows.*x86_64/i, /win.*x86_64/i, /windows.*x64/i);

  const candidate = assets.find((a) => {
    const name = String(a?.name || "");
    if (!name) return false;
    return patterns.some((re) => re.test(name));
  });
  if (candidate && candidate.browser_download_url) return { name: String(candidate.name), url: String(candidate.browser_download_url) };
  return null;
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(
      withProxy(url),
      {
        headers: githubHeaders()
      },
      (res) => {
        // Follow redirects (GitHub does this a lot).
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(() => {
            fs.rmSync(destPath, { force: true });
            download(res.headers.location, destPath).then(resolve, reject);
          });
          return;
        }

        if (res.statusCode !== 200) {
          file.close(() => {
            fs.rmSync(destPath, { force: true });
            reject(new Error(`download_failed:${res.statusCode}`));
          });
          return;
        }

        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }
    );

    request.on("error", (err) => {
      file.close(() => {
        fs.rmSync(destPath, { force: true });
        reject(err);
      });
    });
  });
}

function ensureExecutable(p, platform) {
  if (isWindows(platform)) return;
  try {
    const st = fs.statSync(p);
    if ((st.mode & 0o111) === 0) fs.chmodSync(p, st.mode | 0o755);
  } catch {
    // ignore
  }
}

function findFirstFile(dir, predicate) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const nested = findFirstFile(abs, predicate);
      if (nested) return nested;
    } else if (ent.isFile()) {
      if (predicate(abs)) return abs;
    }
  }
  return null;
}

function extractTarGz(archivePath, outDir) {
  const r = spawnSync("tar", ["-xzf", archivePath, "-C", outDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("tar_extract_failed");
}

function extractZip(archivePath, outDir, platform) {
  if (!isWindows(platform)) {
    const r = spawnSync("unzip", ["-o", archivePath, "-d", outDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("zip_extract_failed");
    return;
  }
  // Windows runner fallback: PowerShell Expand-Archive
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -Path "${archivePath}" -DestinationPath "${outDir}" -Force`],
    { stdio: "inherit" }
  );
  if (r.status !== 0) throw new Error("zip_extract_failed");
}

function usageAndExit(message) {
  if (message) console.error(`[fetch:codex] ${message}`);
  console.error("Usage:");
  console.error("  CODEX_VERSION=0.77.0 pnpm -s run setup:codex");
  console.error("Options (env):");
  console.error("  CODEX_VERSION   Required. Pinned codex release version (no 'v' prefix).");
  console.error("  CODEX_REPO      Optional. Default: openai/codex");
  console.error("  CODEX_OUT_DIR   Optional. Default: assets/codex/bin/<platform-arch>/");
  console.error("  GITHUB_TOKEN    Optional. Used to avoid GitHub API rate limits.");
  process.exit(1);
}

async function main() {
  const skip =
    String(process.env.XCODING_SKIP_CODEX_SETUP || process.env.XCODING_SKIP_CODEX_DOWNLOAD || "")
      .trim()
      .toLowerCase() === "1";
  if (skip) {
    console.log("[fetch:codex] Skipped (XCODING_SKIP_CODEX_SETUP=1).");
    return;
  }

  const platform = process.platform;
  const arch = process.arch;
  const exeName = isWindows(platform) ? "codex.exe" : "codex";

  const version = (process.env.CODEX_VERSION || "").trim() || readPinnedVersion();
  if (!version || version === "0.0.0") {
    usageAndExit("Missing pinned version. Set CODEX_VERSION or edit assets/codex/version.txt");
  }

  const repo = (process.env.CODEX_REPO || "openai/codex").trim();
  const tagsToTry = [`rust-v${version}`, `v${version}`];
  let release = null;
  let lastErr = null;
  for (const tag of tagsToTry) {
    const apiUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
    try {
      release = await fetchJson(apiUrl);
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("github_api_failed:403")) {
        usageAndExit("GitHub API rate limit exceeded. Set GITHUB_TOKEN and retry.");
      }
      // 404 means this tag doesn't exist; try the next tag form.
      if (!msg.includes("github_api_failed:404")) throw e;
    }
  }
  if (!release) throw lastErr || new Error("github_release_not_found");

  const assetInfo = selectAssetFromRelease(release, platform, arch);
  if (!assetInfo) {
    const names = Array.isArray(release?.assets) ? release.assets.map((a) => String(a?.name || "")).filter(Boolean) : [];
    throw new Error(`release_asset_not_found:${platform}/${arch}\nassets:\n- ${names.join("\n- ")}`);
  }

  const outDir =
    (process.env.CODEX_OUT_DIR && process.env.CODEX_OUT_DIR.trim()) ||
    path.join(repoRoot(), "assets", "codex", "bin", platformArchDir(platform, arch));
  const outPath = path.join(outDir, exeName);

  fs.mkdirSync(outDir, { recursive: true });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xcoding-codex-"));
  const archivePath = path.join(tmpRoot, assetInfo.name);
  const extractDir = path.join(tmpRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  console.log(`[fetch:codex] Downloading ${assetInfo.url}`);
  await download(assetInfo.url, archivePath);

  if (assetInfo.name.endsWith(".tar.gz")) extractTarGz(archivePath, extractDir);
  else if (assetInfo.name.endsWith(".zip")) extractZip(archivePath, extractDir, platform);
  else throw new Error("unknown_archive_type");

  const extracted = findFirstFile(extractDir, (p) => {
    const base = path.basename(p).toLowerCase();
    if (isWindows(platform)) return base === "codex.exe" || base.startsWith("codex") && base.endsWith(".exe");
    return base === "codex" || base.startsWith("codex-");
  });

  if (!extracted) throw new Error("extracted_binary_not_found");
  fs.copyFileSync(extracted, outPath);
  ensureExecutable(outPath, platform);

  console.log("[fetch:codex] Done:");
  console.log(`  version: ${version}`);
  console.log(`  asset:   ${assetInfo.name}`);
  console.log(`  out:     ${outPath}`);
}

main().catch((e) => {
  console.error(`[fetch:codex] Failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
