// 主题包管理：扫描 userData/themes 下的主题目录，并解析 VS Code 风格的 theme.json。
// 主进程负责校验与解析与回退，渲染进程只接收受控的结构化主题数据并应用。
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import * as yauzl from "yauzl";

export type ThemeAppearance = "dark" | "light";

export type ThemeSource = "builtin" | "user";

export type ThemePackSummary = {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  source: ThemeSource;
};

export type MonacoThemeRule = {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
};

export type MonacoThemeData = {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: MonacoThemeRule[];
  colors: Record<string, string>;
};

export type ResolvedThemePack = {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  cssVars: Record<string, string>;
  monacoThemeName: string;
  monacoThemeData?: MonacoThemeData;
  extraCssText?: string;
};

const BUILTIN_THEME_PACKS: ThemePackSummary[] = [
  { id: "builtin-dark", name: "XCoding Dark", appearance: "dark", source: "builtin" },
  { id: "builtin-light", name: "XCoding Light", appearance: "light", source: "builtin" }
];

const MONACO_BUILTIN_DARK = "xcoding-dark";
const MONACO_BUILTIN_LIGHT = "xcoding-light";

type ThemeJson = {
  name?: unknown;
  type?: unknown;
  appearance?: unknown;
  colors?: unknown;
  tokenColors?: unknown;
  css?: unknown;
  cssVars?: unknown;
};

type CacheEntry = {
  themeJsonMtimeMs: number;
  cssRelPath: string | null;
  cssMtimeMs: number;
  resolved: ResolvedThemePack;
};

const cacheById = new Map<string, CacheEntry>();

export type ImportThemePackResult =
  | { ok: true; themeId: string; didReplace: boolean }
  | { ok: false; reason: string; themeId?: string };

export function themesRootPath() {
  return path.join(app.getPath("userData"), "themes");
}

export function ensureThemesRoot() {
  try {
    fs.mkdirSync(themesRootPath(), { recursive: true });
  } catch {
    // ignore
  }
}

export function listThemePacks(): ThemePackSummary[] {
  const userThemes: ThemePackSummary[] = [];
  try {
    const root = themesRootPath();
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      const themePath = path.join(root, id, "theme.json");
      const parsed = readThemeJson(themePath);
      if (!parsed) continue;

      const appearance = getThemeAppearance(parsed);
      const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : id;
      userThemes.push({ id, name, appearance, source: "user" });
    }
  } catch {
    // ignore
  }

  userThemes.sort((a, b) => a.name.localeCompare(b.name));
  return [...BUILTIN_THEME_PACKS, ...userThemes];
}

export function resolveThemePack(themePackId: string): ResolvedThemePack {
  const requested = String(themePackId ?? "").trim();
  const builtin = BUILTIN_THEME_PACKS.find((t) => t.id === requested);
  if (builtin) {
    return {
      id: builtin.id,
      name: builtin.name,
      appearance: builtin.appearance,
      cssVars: {},
      monacoThemeName: builtin.appearance === "light" ? MONACO_BUILTIN_LIGHT : MONACO_BUILTIN_DARK,
      extraCssText: ""
    };
  }

  if (!isSafeThemeDirName(requested)) return resolveThemePack("builtin-dark");

  const root = themesRootPath();
  const id = requested || "builtin-dark";
  const themeJsonPath = resolveWithinDir(root, path.join(id, "theme.json"));
  if (!themeJsonPath) return resolveThemePack("builtin-dark");
  const stat = safeStat(themeJsonPath);
  if (!stat) return resolveThemePack("builtin-dark");

  const themeDir = path.dirname(themeJsonPath);
  const cached = cacheById.get(id);
  if (cached && cached.themeJsonMtimeMs === stat.mtimeMs) {
    if (!cached.cssRelPath) return cached.resolved;
    const cssAbs = resolveWithinDir(themeDir, cached.cssRelPath);
    const cssStat = cssAbs ? safeStat(cssAbs) : null;
    const cssMtimeMs = cssStat?.mtimeMs ?? 0;
    if (cssMtimeMs === cached.cssMtimeMs) return cached.resolved;
  }

  const parsed = readThemeJson(themeJsonPath);
  if (!parsed) return resolveThemePack("builtin-dark");

  const appearance = getThemeAppearance(parsed);
  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : id;

  const cssVars: Record<string, string> = {};
  const colors = (isPlainObject(parsed.colors) ? parsed.colors : {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const varName = `--vscode-${key.replace(/\./g, "-")}`;
    cssVars[varName] = value.trim();
  }
  {
    const cursorFg = colors["terminalCursor.foreground"];
    if (typeof cursorFg === "string" && cursorFg.trim() && !cssVars["--vscode-terminal-cursor"]) {
      cssVars["--vscode-terminal-cursor"] = cursorFg.trim();
    }
  }

  const extraVars = isPlainObject(parsed.cssVars) ? (parsed.cssVars as Record<string, unknown>) : null;
  if (extraVars) {
    for (const [k, v] of Object.entries(extraVars)) {
      if (typeof k !== "string" || !k.startsWith("--")) continue;
      if (typeof v !== "string" || !v.trim()) continue;
      cssVars[k] = v.trim();
    }
  }

  const cssRelPath = typeof parsed.css === "string" && parsed.css.trim() ? parsed.css.trim() : null;
  const cssAbs = cssRelPath ? resolveWithinDir(themeDir, cssRelPath) : null;
  const cssStat = cssAbs ? safeStat(cssAbs) : null;
  const cssMtimeMs = cssStat?.mtimeMs ?? 0;

  const extraCssText = cssRelPath ? readThemeCss(themeDir, cssRelPath) : "";

  const monacoThemeName = `xcoding-pack-${sanitizeThemeId(id)}`;
  const monacoThemeData = buildMonacoThemeData({ appearance, colors, tokenColors: parsed.tokenColors });

  const resolved: ResolvedThemePack = {
    id,
    name,
    appearance,
    cssVars,
    monacoThemeName,
    monacoThemeData,
    extraCssText
  };

  cacheById.set(id, { themeJsonMtimeMs: stat.mtimeMs, cssRelPath, cssMtimeMs, resolved });
  return resolved;
}

export async function importThemePackFromZip(
  zipPath: string,
  { overwrite }: { overwrite: boolean }
): Promise<ImportThemePackResult> {
  const absZipPath = String(zipPath ?? "").trim();
  if (!absZipPath) return { ok: false, reason: "empty_zip_path" };
  const zipStat = safeStat(absZipPath);
  if (!zipStat || !zipStat.isFile()) return { ok: false, reason: "zip_not_found" };

  ensureThemesRoot();

  const root = themesRootPath();
  const meta = await readThemeRootFromZip(absZipPath);
  if (!meta) return { ok: false, reason: "theme_json_not_found" };

  const themeId = meta.themeId;
  if (!themeId || !isSafeThemeDirName(themeId) || themeId === "builtin-dark" || themeId === "builtin-light") {
    return { ok: false, reason: "invalid_theme_id", themeId };
  }

  const targetDir = resolveWithinDir(root, themeId);
  if (!targetDir) return { ok: false, reason: "invalid_theme_id", themeId };

  const exists = Boolean(safeStat(targetDir));
  if (exists && !overwrite) return { ok: false, reason: "theme_exists", themeId };

  const tmpDir = fs.mkdtempSync(path.join(root, ".tmp-import-"));
  let didMove = false;
  try {
    await extractThemeZip(absZipPath, meta.rootPrefix, tmpDir);

    const extractedThemeJsonPath = path.join(tmpDir, "theme.json");
    const extractedParsed = readThemeJson(extractedThemeJsonPath);
    if (!extractedParsed) throw new Error("invalid_theme_json");

    if (exists) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(tmpDir, targetDir);
    didMove = true;

    cacheById.delete(themeId);
    return { ok: true, themeId, didReplace: exists };
  } catch (e) {
    const knownReasons = new Set([
      "theme_json_not_found",
      "invalid_theme_json",
      "unsafe_entry_path",
      "symlink_not_allowed",
      "too_many_files",
      "file_too_large",
      "total_too_large"
    ]);
    const rawReason = e instanceof Error ? e.message : "";
    const reason = knownReasons.has(rawReason) ? rawReason : "import_failed";
    return { ok: false, reason, themeId };
  } finally {
    if (!didMove) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

function safeStat(p: string) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readThemeJson(themeJsonPath: string): ThemeJson | null {
  try {
    const raw = fs.readFileSync(themeJsonPath, "utf8");
    const parsed = JSON.parse(raw) as ThemeJson;
    if (!isPlainObject(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function getThemeAppearance(parsed: ThemeJson): ThemeAppearance {
  if (parsed.appearance === "dark" || parsed.appearance === "light") return parsed.appearance;
  if (parsed.type === "dark" || parsed.type === "light") return parsed.type;
  return "dark";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function sanitizeThemeId(id: string) {
  const raw = String(id ?? "").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return cleaned || "theme";
}

function isSafeThemeDirName(id: string) {
  if (!id) return false;
  if (id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  return true;
}

function readThemeCss(themeDir: string, relPath: string) {
  const abs = resolveWithinDir(themeDir, relPath);
  if (!abs) return "";
  try {
    const raw = fs.readFileSync(abs, "utf8");
    return rewriteCssUrlsToFile(stripCssImports(raw), themeDir);
  } catch {
    return "";
  }
}

function resolveWithinDir(dir: string, rel: string) {
  const abs = path.resolve(dir, rel);
  const relToDir = path.relative(dir, abs);
  if (!relToDir || relToDir.startsWith("..") || path.isAbsolute(relToDir)) return null;

  // 防止通过符号链接逃逸主题目录（仅在目标存在时校验 realpath）。
  try {
    const realDir = fs.realpathSync(dir);
    const realAbs = fs.realpathSync(abs);
    const relReal = path.relative(realDir, realAbs);
    if (!relReal || relReal.startsWith("..") || path.isAbsolute(relReal)) return null;
  } catch {
    // ignore
  }
  return abs;
}

function rewriteCssUrlsToFile(cssText: string, themeDir: string) {
  return cssText.replace(/url\(\s*(?:'([^']+)'|"([^"]+)"|([^)\s]+))\s*\)/g, (_m, q1, q2, q3) => {
    const raw = String(q1 || q2 || q3 || "").trim();
    if (!raw) return `url("")`;
    if (/^(https?:|data:|javascript:|file:)/i.test(raw)) return `url("")`;

    const abs = resolveWithinDir(themeDir, raw);
    if (!abs) return `url("")`;
    return `url("${pathToFileURL(abs).toString()}")`;
  });
}

function stripCssImports(cssText: string) {
  // 主题包禁止拉取远程 CSS：移除 @import（即使是相对路径也不需要，避免复杂度与风险）。
  return cssText.replace(
    /@import\s+(?:url\(\s*(?:'[^']+'|"[^"]+"|[^)\s;]+)\s*\)|'[^']+'|"[^"]+")[^;]*;/gi,
    ""
  );
}

async function readThemeRootFromZip(zipPath: string): Promise<{ rootPrefix: string; themeId: string } | null> {
  const zipfile = await openZip(zipPath);
  try {
    const best = await findBestThemeJsonEntry(zipfile);
    if (!best) return null;

    const dir = path.posix.dirname(best.normalizedPath);
    const rootPrefix = dir === "." ? "" : `${dir.replace(/\/+$/g, "")}/`;

    const themeIdRaw = rootPrefix ? rootPrefix.split("/").filter(Boolean).pop() || "" : path.basename(zipPath, path.extname(zipPath));
    const themeId = sanitizeThemeId(themeIdRaw);
    return { rootPrefix, themeId };
  } finally {
    try {
      zipfile.close();
    } catch {
      // ignore
    }
  }
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error("failed_to_open_zip"));
      resolve(zipfile);
    });
  });
}

async function findBestThemeJsonEntry(zipfile: yauzl.ZipFile): Promise<{ normalizedPath: string; depth: number } | null> {
  return new Promise((resolve, reject) => {
    let best: { normalizedPath: string; depth: number } | null = null;

    const onError = (err: unknown) => reject(err);
    zipfile.once("error", onError);

    zipfile.readEntry();
    zipfile.on("entry", (entry) => {
      const raw = normalizeZipEntryName(entry.fileName);
      if (!raw || raw.endsWith("/")) {
        zipfile.readEntry();
        return;
      }

      if (path.posix.basename(raw).toLowerCase() === "theme.json") {
        const depth = raw.split("/").filter(Boolean).length;
        if (!best || depth < best.depth) best = { normalizedPath: raw, depth };
      }

      zipfile.readEntry();
    });

    zipfile.once("end", () => {
      zipfile.removeListener("error", onError);
      resolve(best);
    });
  });
}

function normalizeZipEntryName(name: string) {
  const raw = String(name ?? "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return null;
  let s = raw.replace(/^\/+/g, "");
  s = s.replace(/^\.\//, "");
  // Reject obvious path traversal.
  const parts = s.split("/");
  for (const p of parts) {
    if (!p) continue;
    if (p === "." || p === "..") return null;
  }
  return s;
}

function isZipSymlink(entry: yauzl.Entry) {
  const unixMode = (entry.externalFileAttributes >> 16) & 0xffff;
  const type = unixMode & 0o170000;
  return type === 0o120000;
}

async function extractThemeZip(zipPath: string, rootPrefix: string, destDir: string) {
  const MAX_FILES = 2000;
  const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64MB (fonts etc.)
  const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256MB total extracted

  let files = 0;
  let totalBytes = 0;

  const zipfile = await openZip(zipPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      zipfile.once("error", onError);

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        void (async () => {
          try {
            const normalized = normalizeZipEntryName(entry.fileName);
            if (!normalized) {
              zipfile.readEntry();
              return;
            }

            if (rootPrefix && !normalized.startsWith(rootPrefix)) {
              zipfile.readEntry();
              return;
            }

            const relRaw = rootPrefix ? normalized.slice(rootPrefix.length) : normalized;
            const rel = relRaw.replace(/^\/+/g, "");
            if (!rel) {
              zipfile.readEntry();
              return;
            }

            const isDir = rel.endsWith("/");
            const cleaned = isDir ? rel.replace(/\/+$/g, "") : rel;
            if (!cleaned) {
              zipfile.readEntry();
              return;
            }

            const abs = resolveWithinDir(destDir, cleaned);
            if (!abs) throw new Error("unsafe_entry_path");

            if (isDir) {
              fs.mkdirSync(abs, { recursive: true });
              zipfile.readEntry();
              return;
            }

            if (isZipSymlink(entry)) throw new Error("symlink_not_allowed");

            files += 1;
            if (files > MAX_FILES) throw new Error("too_many_files");

            totalBytes += entry.uncompressedSize;
            if (entry.uncompressedSize > MAX_FILE_BYTES) throw new Error("file_too_large");
            if (totalBytes > MAX_TOTAL_BYTES) throw new Error("total_too_large");

            fs.mkdirSync(path.dirname(abs), { recursive: true });

            await new Promise<void>((res, rej) => {
              zipfile.openReadStream(entry, (err, readStream) => {
                if (err || !readStream) return rej(err || new Error("open_stream_failed"));
                void pipeline(readStream, fs.createWriteStream(abs))
                  .then(() => res())
                  .catch((e) => rej(e));
              });
            });

            zipfile.readEntry();
          } catch (e) {
            try {
              zipfile.close();
            } catch {
              // ignore
            }
            reject(e);
          }
        })();
      });

      zipfile.once("end", () => {
        zipfile.removeListener("error", onError);
        resolve();
      });
    });
  } finally {
    try {
      zipfile.close();
    } catch {
      // ignore
    }
  }
}

function buildMonacoThemeData({
  appearance,
  colors,
  tokenColors
}: {
  appearance: ThemeAppearance;
  colors: Record<string, unknown>;
  tokenColors: unknown;
}): MonacoThemeData {
  const rulesByToken = new Map<string, MonacoThemeRule>();

  const tokenEntries = Array.isArray(tokenColors) ? tokenColors : [];
  for (const entry of tokenEntries) {
    if (!isPlainObject(entry)) continue;
    const settings = isPlainObject((entry as any).settings) ? ((entry as any).settings as Record<string, unknown>) : null;
    if (!settings) continue;

    const foreground = parseMonacoHex(settings.foreground);
    const background = parseMonacoHex(settings.background);
    const fontStyle = typeof settings.fontStyle === "string" && settings.fontStyle.trim() ? settings.fontStyle.trim() : undefined;

    const tokens = extractBaseTokens((entry as any).scope);
    for (const token of tokens) {
      if (!token) continue;
      const existing = rulesByToken.get(token) || { token };
      rulesByToken.set(token, { ...existing, foreground, background, fontStyle });
    }
  }

  const monacoColors: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) {
    if (typeof v !== "string" || !v.trim()) continue;
    monacoColors[k] = v.trim();
  }

  return {
    base: appearance === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [...diffRules(), ...Array.from(rulesByToken.values())],
    colors: monacoColors
  };
}

function extractBaseTokens(scope: unknown): string[] {
  const rawScopes: string[] = [];
  if (typeof scope === "string") rawScopes.push(scope);
  else if (Array.isArray(scope)) rawScopes.push(...scope.filter((s) => typeof s === "string"));

  const out = new Set<string>();
  for (const raw of rawScopes) {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of parts) {
      const base = p.split(/\s+/)[0]?.split(".")[0]?.trim();
      if (!base) continue;
      if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(base)) continue;
      out.add(base);
    }
  }
  return [...out];
}

function parseMonacoHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s.startsWith("#")) return undefined;
  const hex = s.slice(1);
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^[0-9a-fA-F]{3}$/.test(hex)) return hex.split("").map((c) => (c + c).toLowerCase()).join("");
  return undefined;
}

function diffRules(): MonacoThemeRule[] {
  return [
    { token: "diff.add", foreground: "89d185", background: "0f2a12" },
    { token: "diff.delete", foreground: "f14c4c", background: "2a0f0f" },
    { token: "diff.hunkHeader", foreground: "4fc1ff", fontStyle: "bold" },
    { token: "diff.fileHeader", foreground: "569cd6", fontStyle: "bold" },
    { token: "diff.patchHeader", foreground: "c586c0", fontStyle: "bold" },
    { token: "diff.comment", foreground: "6a9955", fontStyle: "italic" },
    { token: "diff.meta", foreground: "9d9d9d", fontStyle: "italic" },
    { token: "diff.context", foreground: "cccccc" }
  ];
}
