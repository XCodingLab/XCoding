import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FSWatcher } from "chokidar";
import ts from "typescript";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-protocol";
import type { LspLanguage, ProjectServiceRequest, ProjectServiceResponse } from "./shared/projectServiceProtocol";

class GitignoreMatcher {
  private patterns: { regex: RegExp; negated: boolean }[] = [];

  constructor(rootPath: string) {
    this.loadGitignore(rootPath);
  }

  private loadGitignore(rootPath: string) {
    const gitignorePath = path.join(rootPath, ".gitignore");
    if (!fs.existsSync(gitignorePath)) return;

    try {
      const content = fs.readFileSync(gitignorePath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        let pattern = trimmed;
        let negated = false;

        if (pattern.startsWith("!")) {
          negated = true;
          pattern = pattern.slice(1);
        }

        const regex = this.patternToRegex(pattern);
        if (regex) this.patterns.push({ regex, negated });
      }
    } catch {
      // ignore .gitignore read errors
    }
  }

  private patternToRegex(pattern: string): RegExp | null {
    try {
      const isDir = pattern.endsWith("/");
      if (isDir) pattern = pattern.slice(0, -1);

      const anchored = pattern.startsWith("/");
      if (anchored) pattern = pattern.slice(1);

      let regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "{{GLOBSTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\{\{GLOBSTAR\}\}/g, ".*");

      if (!anchored) regexStr = `(^|/)${regexStr}`;
      else regexStr = `^${regexStr}`;

      regexStr = `${regexStr}($|/)`;
      return new RegExp(regexStr);
    } catch {
      return null;
    }
  }

  isIgnored(relativePath: string): boolean {
    let ignored = false;
    for (const { regex, negated } of this.patterns) {
      if (regex.test(relativePath)) ignored = !negated;
    }
    return ignored;
  }
}

type RequestMessage = ProjectServiceRequest;
type ResponseMessage = ProjectServiceResponse;

let root: string | null = null;
let watcher: FSWatcher | null = null;
let watcherPaused = false;
let gitignore: GitignoreMatcher | null = null;
let gitStatusCache: { at: number; entries: Record<string, string> } | null = null;
let gitInfoCache: { at: number; info: { isRepo: boolean; repoRoot?: string; branch?: string } } | null = null;
let gitChangesCache:
  | {
      at: number;
      changes: {
        isRepo: boolean;
        repoRoot?: string;
        branch?: string;
        staged: string[];
        unstaged: string[];
        untracked: string[];
        conflict: string[];
        statusByPath: Record<string, string>;
      };
    }
  | null = null;
let rgPath: string | null = null;
let rgChecked = false;
let chokidarModule: typeof import("chokidar") | null = null;

type LspServer = {
  language: LspLanguage;
  connection: MessageConnection;
  initialized: Promise<void>;
  documents: Map<string, { uri: string; version: number; languageId: string }>;
};

const lspServers = new Map<LspLanguage, LspServer>();

function resolvePyrightLangserverPath(): string | null {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    return req.resolve("pyright/langserver.index.js");
  } catch {
    // ignore
  }
  const candidate = path.join(process.cwd(), "node_modules", "pyright", "langserver.index.js");
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function fileUriFromAbsPath(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

function absPathFromFileUri(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

async function ensureLspServer(language: LspLanguage): Promise<LspServer> {
  if (lspServers.has(language)) return lspServers.get(language)!;
  if (!root) throw new Error("not_initialized");

  let proc: ReturnType<typeof spawn>;
  if (language === "python") {
    const pyrightServer = resolvePyrightLangserverPath();
    if (!pyrightServer) throw new Error("pyright_langserver_not_found");
    proc = spawn(process.execPath, [pyrightServer, "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    proc = spawn("gopls", ["-mode=stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  }

  if (!proc.stdout || !proc.stdin) throw new Error("lsp_stdio_unavailable");
  const connection = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
  connection.listen();

  const documents = new Map<string, { uri: string; version: number; languageId: string }>();

  connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
    if (!root) return;
    const abs = absPathFromFileUri(String(params?.uri ?? ""));
    if (!abs) return;
    const rel = path.relative(root, abs).replace(/[\\\\]+/g, "/");
    sendEvent({ type: "lsp:diagnostics", language, relativePath: rel, diagnostics: params.diagnostics ?? [] });
  });

  proc.on("exit", () => {
    lspServers.delete(language);
    sendEvent({ type: "lsp:exit", language, timestamp: Date.now() });
  });

  const rootUri = fileUriFromAbsPath(root);
  const initialized = (async () => {
    await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: {},
          definition: {},
          documentSymbol: {}
        }
      }
    });
    connection.sendNotification("initialized", {});
  })();

  const server: LspServer = { language, connection, initialized, documents };
  lspServers.set(language, server);
  return server;
}

function safeJoin(rel: string) {
  const cleaned = rel.replace(/^([/\\\\])+/, "");
  if (!root) throw new Error("not_initialized");
  const abs = path.join(root, cleaned);
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path_escape");
  return abs;
}

function shouldIgnore(rel: string) {
  const normalized = rel.replace(/^([/\\])+/, "").replace(/[\\]+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.some((p) => p === ".git" || p === "node_modules" || p === "dist");
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".mdx",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".go"
]);

function fuzzyMatch(query: string, target: string): number {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();
  if (targetLower === queryLower) return 1000;
  if (targetLower.includes(queryLower)) {
    if (targetLower.startsWith(queryLower)) return 900;
    return 800 - targetLower.indexOf(queryLower);
  }
  let score = 0;
  let queryIndex = 0;
  let consecutiveBonus = 0;
  for (let i = 0; i < targetLower.length && queryIndex < queryLower.length; i += 1) {
    if (targetLower[i] === queryLower[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex += 1;
    } else {
      consecutiveBonus = 0;
    }
  }
  if (queryIndex === queryLower.length) return score;
  return 0;
}

async function walkDirectory(
  dir: string,
  rootPath: string,
  results: { path: string; name: string; relativePath: string }[],
  maxResults: number,
  matcher: GitignoreMatcher | null
): Promise<void> {
  if (results.length >= maxResults) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === "build") continue;
    const fullPath = path.join(dir, entry);
    const relativePath = path.relative(rootPath, fullPath).replace(/[\\\\]+/g, "/");
    if (matcher?.isIgnored(relativePath)) continue;
    if (shouldIgnore(relativePath)) continue;

    let st: fs.Stats;
    try {
      st = await stat(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      await walkDirectory(fullPath, rootPath, results, maxResults, matcher);
      continue;
    }

    results.push({ path: fullPath, name: entry, relativePath });
  }
}

function parseGlobList(globs?: string[]): string[] {
  if (!Array.isArray(globs)) return [];
  return globs.map((g) => String(g ?? "").trim()).filter(Boolean);
}

async function resolveRipgrepPath(): Promise<string | null> {
  if (rgChecked) return rgPath;
  rgChecked = true;

  // Prefer the bundled ripgrep (VS Code style) when available.
  try {
    const mod = (await import("@vscode/ripgrep")) as any;
    const candidate = typeof mod?.rgPath === "string" ? mod.rgPath : "";
    if (candidate) {
      const diskCandidate = candidate.replace(/\bnode_modules\.asar\b/g, "node_modules.asar.unpacked");
      if (fs.existsSync(diskCandidate)) {
        rgPath = diskCandidate;
        return rgPath;
      }
      if (fs.existsSync(candidate)) {
        rgPath = candidate;
        return rgPath;
      }
    }
  } catch {
    // ignore
  }

  try {
    const command = process.platform === "win32" ? "where.exe rg" : "which rg";
    const found = execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim().split("\n")[0]?.trim();
    if (found) {
      rgPath = found;
      return rgPath;
    }
  } catch {
    // ignore
  }

  rgPath = null;
  return null;
}

function getRgArgs(params: {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  filePattern?: string;
  include?: string[];
  exclude?: string[];
  useGitignore?: boolean;
  maxFileSize?: string;
}): { args: string[]; patternAfterDoubleDash?: string } {
  const args: string[] = ["--hidden", "--no-require-git", "--crlf", "--no-config", "--json", "--line-number", "--column"];

  args.push(params.caseSensitive ? "--case-sensitive" : "--ignore-case");

  // Built-in perf excludes (aligned with EnsoAI baseline).
  const excludes = new Set<string>([
    "!.git/**",
    "!node_modules/**",
    "!dist/**",
    "!build/**",
    "!*.lock",
    "!package-lock.json"
  ]);
  for (const ex of parseGlobList(params.exclude)) excludes.add(`!${ex.replace(/^!+/, "")}`);
  for (const ex of excludes) args.push("-g", ex);

  const includes = parseGlobList(params.include);
  if (includes.length) {
    // VS Code semantics: limit to include globs by first excluding everything.
    args.push("-g", "!*");
    for (const inc of includes) args.push("-g", inc);
  }

  if (params.filePattern) args.push("-g", params.filePattern);

  if (params.useGitignore === false) args.push("--no-ignore");

  if (params.wholeWord) args.push("--word-regexp");

  if (params.maxFileSize) args.push("--max-filesize", params.maxFileSize);

  if (params.regex) {
    args.push("--regexp", params.query);
    return { args };
  }

  args.push("--fixed-strings");
  return { args, patternAfterDoubleDash: params.query };
}

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchRegExp(params: { query: string; regex: boolean; wholeWord: boolean; caseSensitive: boolean }): RegExp | null {
  try {
    const base = params.regex ? params.query : escapeRegExpLiteral(params.query);
    const wordWrapped = params.wholeWord ? `\\b(?:${base})\\b` : base;
    const flags = params.caseSensitive ? "g" : "gi";
    return new RegExp(wordWrapped, flags);
  } catch {
    return null;
  }
}

async function searchContentFallback(options: {
  rootPath: string;
  query: string;
  maxResults: number;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  useGitignore: boolean;
}): Promise<{ matches: any[]; totalMatches: number; totalFiles: number; truncated: boolean }> {
  const matcher = options.useGitignore ? gitignore : null;
  const files: { path: string; name: string; relativePath: string }[] = [];
  await walkDirectory(options.rootPath, options.rootPath, files, Math.max(5000, options.maxResults * 20), matcher);

  const matches: any[] = [];
  let totalMatches = 0;
  const fileSet = new Set<string>();
  let truncated = false;

  let re: RegExp | null = null;
  if (options.regex) {
    try {
      re = new RegExp(options.query, options.caseSensitive ? "g" : "gi");
    } catch {
      return { matches: [], totalMatches: 0, totalFiles: 0, truncated: false };
    }
  }

  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  for (const file of files) {
    if (matches.length >= options.maxResults) break;
    if (!TEXT_EXTENSIONS.has(path.extname(file.name).toLowerCase())) continue;
    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= options.maxResults) break;
      const lineText = lines[i] ?? "";
      if (options.regex && re) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null = null;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
        while ((m = re.exec(lineText)) !== null) {
          const idx = m.index;
          if (options.wholeWord) {
            const before = idx > 0 ? lineText[idx - 1] : "";
            const after = idx + m[0].length < lineText.length ? lineText[idx + m[0].length] : "";
            if ((before && /\w/.test(before)) || (after && /\w/.test(after))) continue;
          }
          totalMatches += 1;
          fileSet.add(file.relativePath);
          matches.push({ path: file.path, relativePath: file.relativePath, line: i + 1, column: idx + 1, content: lineText });
          if (matches.length >= options.maxResults) {
            truncated = true;
            break;
          }
        }
        continue;
      }

      const haystack = options.caseSensitive ? lineText : lineText.toLowerCase();
      const idx = haystack.indexOf(needle);
      if (idx === -1) continue;
      if (options.wholeWord) {
        const before = idx > 0 ? lineText[idx - 1] : "";
        const after = idx + options.query.length < lineText.length ? lineText[idx + options.query.length] : "";
        if ((before && /\w/.test(before)) || (after && /\w/.test(after))) continue;
      }
      totalMatches += 1;
      fileSet.add(file.relativePath);
      matches.push({ path: file.path, relativePath: file.relativePath, line: i + 1, column: idx + 1, content: lineText });
    }
  }

  if (matches.length >= options.maxResults) truncated = true;
  return { matches, totalMatches, totalFiles: fileSet.size, truncated };
}

function searchPaths(query: string, limit: number) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: string[] = [];
  const stack: string[] = [""];
  const startedAt = Date.now();
  const TIME_LIMIT_MS = 700;

  while (stack.length && results.length < limit && Date.now() - startedAt < TIME_LIMIT_MS) {
    const dir = stack.pop() ?? "";
    const absDir = safeJoin(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const rel = (dir ? `${dir}/${ent.name}` : ent.name).replace(/[\\]+/g, "/");
      if (shouldIgnore(rel)) continue;
      if (ent.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (rel.toLowerCase().includes(q)) results.push(rel);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function getGitStatusPorcelain(cwd: string, maxEntries: number): Record<string, string> {
  try {
    const out = execSync("git status --porcelain=v1 -z", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parts = out.split("\0").filter(Boolean);
    const entries: Record<string, string> = {};
    for (let i = 0; i < parts.length; i += 1) {
      const rec = parts[i] ?? "";
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      const rest = rec.slice(3);
      const isRename = xy.startsWith("R") || xy.startsWith("C");
      if (isRename) {
        const from = rest.replace(/[\\\\]+/g, "/");
        const to = (parts[i + 1] ?? "").replace(/[\\\\]+/g, "/");
        if (to) {
          entries[to] = xy.trim();
          i += 1;
        } else if (from.includes(" -> ")) {
          const nextTo = from.split(" -> ").pop() ?? "";
          if (nextTo) entries[nextTo] = xy.trim();
        }
      } else {
        const rel = rest.replace(/[\\\\]+/g, "/");
        if (!rel) continue;
        entries[rel] = xy.trim();
      }
      if (Object.keys(entries).length >= maxEntries) break;
    }
    return entries;
  } catch {
    return {};
  }
}

function normalizeGitRelPath(input: string) {
  const raw = String(input ?? "").replace(/[\\\\]+/g, "/").replace(/^([/\\\\])+/, "");
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("..")) throw new Error("path_escape");
  return normalized;
}

function isNotGitRepoError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.includes("not a git repository");
}

async function runGitCapture(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number; maxBytes?: number; allowExitCodes?: number[] }
): Promise<{ stdout: string; stderr: string; truncated: boolean; exitCode: number | null }> {
  const allowExitCodes = options?.allowExitCodes ?? [0];
  const maxBytes = typeof options?.maxBytes === "number" ? Math.max(1_000, options.maxBytes) : null;
  const timeoutMs = typeof options?.timeoutMs === "number" ? Math.max(200, options.timeoutMs) : 0;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let killedForTruncation = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const finish = (exitCode: number | null) => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      const ok = killedForTruncation || (typeof exitCode === "number" && allowExitCodes.includes(exitCode));
      if (!ok) {
        const msg = (stderr || stdout || "").trim() || `git_exit_${exitCode ?? "null"}`;
        reject(new Error(msg));
        return;
      }
      resolve({ stdout, stderr, truncated, exitCode });
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        reject(new Error("git_timeout"));
      }, timeoutMs);
    }

    proc.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      reject(err);
    });

    proc.stdout?.on("data", (chunk) => {
      if (killedForTruncation) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!text) return;
      stdout += text;
      if (maxBytes && stdout.length > maxBytes) {
        stdout = stdout.slice(0, maxBytes);
        truncated = true;
        killedForTruncation = true;
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
    });

    proc.stderr?.on("data", (chunk) => {
      if (killedForTruncation) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!text) return;
      stderr += text;
      if (maxBytes && stderr.length > maxBytes) stderr = stderr.slice(0, maxBytes);
    });

    proc.on("close", (code) => finish(typeof code === "number" ? code : null));
  });
}

async function getGitRepoInfo(cwd: string) {
  try {
    const rootRes = await runGitCapture(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 4000 });
    const repoRoot = rootRes.stdout.trim();
    if (!repoRoot) return { isRepo: true as const, repoRoot: cwd };

    let branch = "";
    try {
      const branchRes = await runGitCapture(cwd, ["symbolic-ref", "--short", "HEAD"], { timeoutMs: 2500 });
      branch = branchRes.stdout.trim();
    } catch {
      try {
        const branchRes = await runGitCapture(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 2500 });
        branch = branchRes.stdout.trim();
      } catch {
        // ignore
      }
    }

    return { isRepo: true as const, repoRoot, branch: branch || undefined };
  } catch (e) {
    if (isNotGitRepoError(e)) return { isRepo: false as const };
    throw e;
  }
}

function parseGitStatusPorcelainV1Z(output: string, maxEntries: number) {
  const parts = String(output ?? "").split("\0").filter(Boolean);
  const entries: Array<{ path: string; x: string; y: string; from?: string }> = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (entries.length >= maxEntries) break;
    const rec = parts[i] ?? "";
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const rest = rec.slice(3);
    const isRename = x === "R" || x === "C";
    if (isRename) {
      const from = rest.replace(/[\\\\]+/g, "/");
      const to = (parts[i + 1] ?? "").replace(/[\\\\]+/g, "/");
      if (to) {
        entries.push({ path: to, x, y, from });
        i += 1;
        continue;
      }
      if (from.includes(" -> ")) {
        const to2 = from.split(" -> ").pop() ?? "";
        const from2 = from.split(" -> ")[0] ?? "";
        if (to2) entries.push({ path: to2, x, y, from: from2 || undefined });
        continue;
      }
      if (from) entries.push({ path: from, x, y });
      continue;
    }
    const p = rest.replace(/[\\\\]+/g, "/");
    if (!p) continue;
    entries.push({ path: p, x, y });
  }
  return entries;
}

function mapPorcelainToStatusLetter(x: string, y: string) {
  const xy = `${x}${y}`;
  const conflictSet = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  if (conflictSet.has(xy) || x === "U" || y === "U") return "U";
  if (xy === "??") return "?";
  if (x === "D" || y === "D") return "D";
  if (x === "A") return "A";
  if (x === "R") return "R";
  if (x === "C") return "C";
  if (x === "M" || y === "M") return "M";
  if (x === "!") return "!";
  return x.trim() || y.trim() || "";
}

function makeNewFileUnifiedDiff(relPath: string, content: string) {
  const normalizedPath = relPath.replace(/^([/\\\\])+/, "").replace(/[\\\\]+/g, "/");
  const normalized = content.replace(/\r\n/g, "\n");
  const hasFinalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasFinalNewline) lines.pop();
  const lineCount = lines.length;
  const header = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${normalizedPath}`
  ];
  if (lineCount === 0) return `${header.join("\n")}\n`;
  const hunk = [`@@ -0,0 +1,${lineCount} @@`, ...lines.map((l) => `+${l}`)];
  const eof = hasFinalNewline ? [] : ["\\ No newline at end of file"];
  return `${[...header, ...hunk, ...eof].join("\n")}\n`;
}

function readUtf8FileLimited(absPath: string, maxBytes: number): { text: string; truncated: boolean } {
  const st = fs.statSync(absPath);
  if (!st.isFile()) return { text: "", truncated: false };
  const size = st.size ?? 0;
  if (size <= 0) return { text: "", truncated: false };
  const truncated = size > maxBytes;
  const toRead = truncated ? maxBytes : size;
  if (toRead <= 0) return { text: "", truncated };
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(toRead);
    const read = fs.readSync(fd, buf, 0, toRead, 0);
    const sliced = read === toRead ? buf : buf.subarray(0, read);
    return { text: sliced.toString("utf8"), truncated };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

async function isGitBinaryPath(repoCwd: string, relPath: string) {
  // git diff --numstat returns "-" "-" for binary diffs.
  try {
    const res = await runGitCapture(repoCwd, ["diff", "--numstat", "--no-color", "--", relPath], { timeoutMs: 7000, maxBytes: 300_000, allowExitCodes: [0, 1] });
    const firstLine = res.stdout.split("\n").find((l) => l.trim()) ?? "";
    if (!firstLine) return false;
    const parts = firstLine.split("\t");
    const added = (parts[0] ?? "").trim();
    const removed = (parts[1] ?? "").trim();
    return added === "-" && removed === "-";
  } catch {
    return false;
  }
}

function reply(message: ResponseMessage) {
  if (typeof process.send === "function") process.send(message);
}

function sendEvent(payload: unknown) {
  if (typeof process.send === "function") process.send({ type: "event", payload });
}

function ensureChokidar(): typeof import("chokidar") {
  if (chokidarModule) return chokidarModule;
  // Resolve from the app root so it works in both dev and packaged (asar) builds.
  // dist/main/projectService.cjs -> app root package.json (../..)
  const req = createRequire(path.join(__dirname, "..", "..", "package.json"));
  chokidarModule = req("chokidar") as typeof import("chokidar");
  return chokidarModule;
}

function ensureWatcherStarted() {
  if (!root) throw new Error("not_initialized");
  if (watcher) return;
  try {
    const chokidar = ensureChokidar();
    watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      ignored: [/[/\\\\]\.git([/\\\\]|$)/, /[/\\\\]node_modules([/\\\\]|$)/, /[/\\\\]dist([/\\\\]|$)/]
    });
    watcher.on("all", (event, absPath) => {
      if (watcherPaused || !root) return;
      gitStatusCache = null;
      gitInfoCache = null;
      gitChangesCache = null;
      const rel = path.relative(root, absPath).replace(/[\\\\]+/g, "/");
      if (rel.startsWith("..")) return;
      sendEvent({ type: "watcher", event, path: rel, timestamp: Date.now() });
    });
    watcher.on("error", (error) => {
      sendEvent({ type: "watcher:error", error: String(error) });
    });
  } catch (e) {
    sendEvent({ type: "watcher:error", error: e instanceof Error ? e.message : String(e) });
    watcher = null;
  }
}

async function stopWatcher() {
  if (!watcher) return;
  const w = watcher;
  watcher = null;
  try {
    await w.close();
  } catch {
    // ignore
  }
}

process.on("message", (msg: RequestMessage) => {
  try {
    if (!msg || typeof msg !== "object" || typeof (msg as any).id !== "string") return;

    if (msg.type === "init") {
      const projectPath = msg.projectPath;
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw new Error("invalid_project_path");
      root = projectPath;
      gitignore = new GitignoreMatcher(projectPath);
      reply({ id: msg.id, ok: true, result: { root } });
      return;
    }

    if (!root) throw new Error("not_initialized");

    if (msg.type === "watcher:start") {
      ensureWatcherStarted();
      reply({ id: msg.id, ok: true, result: { watching: Boolean(watcher) } });
      return;
    }

    if (msg.type === "watcher:setPaused") {
      watcherPaused = Boolean(msg.paused);
      reply({ id: msg.id, ok: true, result: { paused: watcherPaused } });
      return;
    }

    if (msg.type === "watcher:stop") {
      void stopWatcher().then(() => reply({ id: msg.id, ok: true, result: { watching: false } }));
      return;
    }

    if (msg.type === "lang:ts:diagnostics") {
      // Lightweight TS diagnostics: only parse+syntax (no project-wide typecheck).
      const fileName = msg.relPath.replace(/[\\]+/g, "/");
      const transpile = ts.transpileModule(msg.content, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
      });
      const source = ts.createSourceFile(fileName, msg.content, ts.ScriptTarget.Latest, true);
      const diags = transpile.diagnostics ?? [];
      const formatted = diags.map((d: import("typescript").Diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
        const pos = d.start != null ? source.getLineAndCharacterOfPosition(d.start) : null;
        return {
          code: d.code,
          message,
          line: pos ? pos.line + 1 : 0,
          column: pos ? pos.character + 1 : 0,
          category: ts.DiagnosticCategory[d.category]
        };
      });
      reply({ id: msg.id, ok: true, result: { diagnostics: formatted } });
      return;
    }

    if (msg.type === "fs:readFile") {
      const abs = safeJoin(msg.relPath);
      if (!fs.existsSync(abs)) {
        reply({ id: msg.id, ok: false, error: "file_not_found" });
        return;
      }
      reply({ id: msg.id, ok: true, result: { content: fs.readFileSync(abs, "utf8") } });
      return;
    }

    if (msg.type === "fs:writeFile") {
      const abs = safeJoin(msg.relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, msg.content, "utf8");
      reply({ id: msg.id, ok: true, result: { written: true } });
      return;
    }

    if (msg.type === "fs:deleteFile") {
      const abs = safeJoin(msg.relPath);
      if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      reply({ id: msg.id, ok: true, result: { deleted: true } });
      return;
    }

    if (msg.type === "fs:deleteDir") {
      const abs = safeJoin(msg.relDir);
      if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
      reply({ id: msg.id, ok: true, result: { deleted: true } });
      return;
    }

    if (msg.type === "fs:mkdir") {
      const abs = safeJoin(msg.relDir);
      fs.mkdirSync(abs, { recursive: true });
      reply({ id: msg.id, ok: true, result: { created: true } });
      return;
    }

    if (msg.type === "fs:rename") {
      const fromAbs = safeJoin(msg.from);
      const toAbs = safeJoin(msg.to);
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      fs.renameSync(fromAbs, toAbs);
      reply({ id: msg.id, ok: true, result: { renamed: true } });
      return;
    }

    if (msg.type === "fs:stat") {
      const abs = safeJoin(msg.relPath);
      if (!fs.existsSync(abs)) {
        reply({ id: msg.id, ok: true, result: { exists: false } });
        return;
      }
      const st = fs.statSync(abs);
      reply({
        id: msg.id,
        ok: true,
        result: { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs }
      });
      return;
    }

    if (msg.type === "fs:listDir") {
      const absDir = safeJoin(msg.relDir);
      if (!fs.existsSync(absDir)) throw new Error("dir_not_found");
      const entries = fs.readdirSync(absDir, { withFileTypes: true }).map((d) => {
        const name = d.name;
        const kind = d.isDirectory() ? ("dir" as const) : ("file" as const);
        const relPath = msg.relDir ? `${msg.relDir.replace(/\/+$/, "")}/${name}` : name;
        const normalizedRel = relPath.replace(/[\\\\]+/g, "/");
        const ignored = gitignore?.isIgnored(normalizedRel) ?? false;
        return { name, kind, ignored };
      });
      reply({ id: msg.id, ok: true, result: { entries } });
      return;
    }

    if (msg.type === "fs:searchPaths") {
      const limit = typeof msg.limit === "number" ? Math.max(1, Math.min(2000, msg.limit)) : 200;
      const results = searchPaths(msg.query ?? "", limit);
      reply({ id: msg.id, ok: true, result: { results } });
      return;
    }

    if (msg.type === "fs:gitStatus") {
      if (!root) throw new Error("not_initialized");
      const maxEntries = typeof msg.maxEntries === "number" ? Math.max(10, Math.min(200000, msg.maxEntries)) : 50000;
      const now = Date.now();
      if (!gitStatusCache || now - gitStatusCache.at > 1200) {
        gitStatusCache = { at: now, entries: getGitStatusPorcelain(root, maxEntries) };
      }
      reply({ id: msg.id, ok: true, result: { entries: gitStatusCache.entries } });
      return;
    }

    if (msg.type === "fs:gitInfo") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const now = Date.now();
        if (!gitInfoCache || now - gitInfoCache.at > 1200) {
          const info = await getGitRepoInfo(root);
          gitInfoCache = { at: now, info: info.isRepo ? { isRepo: true, repoRoot: info.repoRoot, branch: info.branch } : { isRepo: false } };
        }
        reply({ id: msg.id, ok: true, result: gitInfoCache.info });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_info_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitChanges") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const maxEntries = typeof msg.maxEntries === "number" ? Math.max(10, Math.min(200000, msg.maxEntries)) : 50000;
        const now = Date.now();
        if (gitChangesCache && now - gitChangesCache.at <= 1200) {
          reply({ id: msg.id, ok: true, result: gitChangesCache.changes });
          return;
        }

        const info = await getGitRepoInfo(root);
        if (!info.isRepo) {
          const empty = { isRepo: false, staged: [], unstaged: [], untracked: [], conflict: [], statusByPath: {} };
          gitChangesCache = { at: now, changes: empty };
          reply({ id: msg.id, ok: true, result: empty });
          return;
        }

        const statusRes = await runGitCapture(root, ["status", "--porcelain=v1", "-z"], { timeoutMs: 7000, maxBytes: 5_000_000 });
        const parsed = parseGitStatusPorcelainV1Z(statusRes.stdout, maxEntries);

        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];
        const conflict: string[] = [];
        const statusByPath: Record<string, string> = {};

        const conflictSet = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

        for (const ent of parsed) {
          const rel = normalizeGitRelPath(ent.path);
          if (!rel) continue;
          const x = ent.x;
          const y = ent.y;
          const xy = `${x}${y}`;

          const letter = mapPorcelainToStatusLetter(x, y);
          if (letter) statusByPath[rel] = letter;

          if (xy === "??") {
            untracked.push(rel);
          } else {
            if (x && x !== " " && x !== "?") staged.push(rel);
            if (y && y !== " " && y !== "?") unstaged.push(rel);
            if (conflictSet.has(xy) || x === "U" || y === "U") conflict.push(rel);
          }
        }

        const changes = { isRepo: true, repoRoot: info.repoRoot, branch: info.branch, staged, unstaged, untracked, conflict, statusByPath };
        gitChangesCache = { at: now, changes };
        gitInfoCache = { at: now, info: { isRepo: true, repoRoot: info.repoRoot, branch: info.branch } };
        reply({ id: msg.id, ok: true, result: changes });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_changes_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitDiff") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const relPath = normalizeGitRelPath(msg.path);
        if (!relPath) throw new Error("invalid_path");
        const mode = msg.mode === "staged" ? "staged" : "working";
        const maxBytes = typeof msg.maxBytes === "number" ? Math.max(50_000, Math.min(20_000_000, msg.maxBytes)) : 3_000_000;

        const info = await getGitRepoInfo(root);
        if (!info.isRepo) throw new Error("not_a_git_repo");

        const now = Date.now();
        const cachedChanges = gitChangesCache && now - gitChangesCache.at <= 1200 ? gitChangesCache.changes : null;
        let statusLetter = cachedChanges?.statusByPath?.[relPath] ?? "";
        if (!statusLetter) {
          try {
            const oneRes = await runGitCapture(root, ["status", "--porcelain=v1", "-z", "--", relPath], { timeoutMs: 4000, maxBytes: 200_000 });
            const parsed = parseGitStatusPorcelainV1Z(oneRes.stdout, 50);
            const match = parsed.find((p) => normalizeGitRelPath(p.path) === relPath) ?? parsed[0] ?? null;
            if (match) statusLetter = mapPorcelainToStatusLetter(match.x, match.y);
          } catch {
            // ignore
          }
        }

	        if (mode === "working" && statusLetter === "?") {
	          const abs = safeJoin(relPath);
	          const st = await stat(abs).catch(() => null);
	          const isText = st?.isFile() && (TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase()) || (st?.size ?? 0) <= 200_000);
	          if (!st?.isFile()) throw new Error("file_not_found");
	          if (!isText) {
            const header = [
              `diff --git a/${relPath} b/${relPath}`,
              "new file mode 100644",
              "--- /dev/null",
              `+++ b/${relPath}`,
              `Binary files /dev/null and b/${relPath} differ`
            ];
	            reply({ id: msg.id, ok: true, result: { diff: `${header.join("\n")}\n`, truncated: false } });
	            return;
	          }
	          const limited = readUtf8FileLimited(abs, maxBytes);
	          reply({ id: msg.id, ok: true, result: { diff: makeNewFileUnifiedDiff(relPath, limited.text), truncated: limited.truncated } });
	          return;
	        }

        const args = ["diff", "--no-color", "--no-ext-diff", ...(mode === "staged" ? ["--staged"] : []), "--", relPath];
        const diffRes = await runGitCapture(root, args, { timeoutMs: 10_000, maxBytes });
        reply({ id: msg.id, ok: true, result: { diff: diffRes.stdout, truncated: diffRes.truncated } });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_diff_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitFileDiff") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const repoCwd = root;
        const relPath = normalizeGitRelPath(msg.path);
        if (!relPath) throw new Error("invalid_path");
        const mode = msg.mode === "staged" ? "staged" : "working";
        const maxBytes = typeof msg.maxBytes === "number" ? Math.max(50_000, Math.min(15_000_000, msg.maxBytes)) : 3_000_000;

        const info = await getGitRepoInfo(repoCwd);
        if (!info.isRepo) throw new Error("not_a_git_repo");

        // For untracked file in working mode: original is empty, modified is disk content.
        const statusRes = await runGitCapture(repoCwd, ["status", "--porcelain=v1", "-z", "--", relPath], { timeoutMs: 4000, maxBytes: 200_000 });
        const parsed = parseGitStatusPorcelainV1Z(statusRes.stdout, 10);
        const match = parsed.find((p) => normalizeGitRelPath(p.path) === relPath) ?? parsed[0] ?? null;
        const xy = match ? `${match.x}${match.y}` : "";

	        if (mode === "working" && xy === "??") {
	          const abs = safeJoin(relPath);
	          const st = await stat(abs).catch(() => null);
	          if (!st?.isFile()) throw new Error("file_not_found");
	          const limited = readUtf8FileLimited(abs, maxBytes);
	          reply({ id: msg.id, ok: true, result: { original: "", modified: limited.text, truncated: limited.truncated, isBinary: false } });
	          return;
	        }

        // Binary detection: keep it simple (only for working tree diff).
        const isBinary = mode === "working" ? await isGitBinaryPath(repoCwd, relPath) : false;
        if (isBinary) {
          reply({ id: msg.id, ok: true, result: { original: "", modified: "", truncated: false, isBinary: true } });
          return;
        }

        // VSCode-like: staged = HEAD vs index; working = index/HEAD vs working tree.
        const readGitShow = async (spec: string) => {
          try {
            const r = await runGitCapture(repoCwd, ["show", spec], { timeoutMs: 10_000, maxBytes });
            return { text: r.stdout, truncated: r.truncated };
          } catch {
            return { text: "", truncated: false };
          }
        };

        let original = "";
        let modified = "";
        let truncated = false;

        if (mode === "staged") {
          const a = await readGitShow(`HEAD:${relPath}`);
          const b = await readGitShow(`:${relPath}`);
          original = a.text;
          modified = b.text;
          truncated = a.truncated || b.truncated;
        } else {
          // working: prefer index as original; fallback to HEAD for new files.
          const a = await readGitShow(`:${relPath}`);
          const a2 = !a.text ? await readGitShow(`HEAD:${relPath}`) : null;
          original = a.text || a2?.text || "";
          truncated = a.truncated || Boolean(a2?.truncated);

	          const abs = safeJoin(relPath);
	          const st = await stat(abs).catch(() => null);
	          if (st?.isFile()) {
	            try {
	              const limited = readUtf8FileLimited(abs, maxBytes);
	              modified = limited.text;
	              truncated = truncated || limited.truncated;
	            } catch {
	              modified = "";
	            }
	          } else {
	            modified = "";
	          }
	        }

        reply({ id: msg.id, ok: true, result: { original, modified, truncated, isBinary: false } });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_file_diff_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitStage") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const info = await getGitRepoInfo(root);
        if (!info.isRepo) throw new Error("not_a_git_repo");
        const paths = Array.isArray(msg.paths) ? msg.paths.map((p) => normalizeGitRelPath(p)).filter(Boolean) : [];
        if (paths.length === 0) {
          reply({ id: msg.id, ok: true, result: { staged: true } });
          return;
        }
        await runGitCapture(root, ["add", "--", ...paths], { timeoutMs: 30_000 });
        gitStatusCache = null;
        gitInfoCache = null;
        gitChangesCache = null;
        reply({ id: msg.id, ok: true, result: { staged: true } });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_stage_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitUnstage") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const info = await getGitRepoInfo(root);
        if (!info.isRepo) throw new Error("not_a_git_repo");
        const paths = Array.isArray(msg.paths) ? msg.paths.map((p) => normalizeGitRelPath(p)).filter(Boolean) : [];
        if (paths.length === 0) {
          reply({ id: msg.id, ok: true, result: { unstaged: true } });
          return;
        }
        try {
          await runGitCapture(root, ["reset", "-q", "HEAD", "--", ...paths], { timeoutMs: 30_000 });
        } catch {
          await runGitCapture(root, ["rm", "--cached", "-r", "--", ...paths], { timeoutMs: 30_000 });
        }
        gitStatusCache = null;
        gitInfoCache = null;
        gitChangesCache = null;
        reply({ id: msg.id, ok: true, result: { unstaged: true } });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_unstage_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitDiscard") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const info = await getGitRepoInfo(root);
        if (!info.isRepo) throw new Error("not_a_git_repo");
        const includeUntracked = Boolean(msg.includeUntracked);
        const paths = Array.isArray(msg.paths) ? msg.paths.map((p) => normalizeGitRelPath(p)).filter(Boolean) : [];
        if (paths.length === 0) {
          reply({ id: msg.id, ok: true, result: { discarded: true } });
          return;
        }

        const now = Date.now();
        const cachedChanges = gitChangesCache && now - gitChangesCache.at <= 1200 ? gitChangesCache.changes : null;
        const untrackedSet = new Set<string>();
        if (cachedChanges) {
          for (const p of cachedChanges.untracked) untrackedSet.add(p);
        } else if (includeUntracked) {
          try {
            const statusRes = await runGitCapture(root, ["status", "--porcelain=v1", "-z", "--", ...paths], { timeoutMs: 7000, maxBytes: 500_000 });
            const parsed = parseGitStatusPorcelainV1Z(statusRes.stdout, Math.max(200, paths.length * 20));
            for (const ent of parsed) {
              const rel = normalizeGitRelPath(ent.path);
              if (!rel) continue;
              if (`${ent.x}${ent.y}` === "??") untrackedSet.add(rel);
            }
          } catch {
            // ignore
          }
        }
        const deleteTargets = includeUntracked ? paths.filter((p) => untrackedSet.has(p)) : [];
        const restoreTargets = paths.filter((p) => !untrackedSet.has(p));

        if (deleteTargets.length > 0) {
          await runGitCapture(root, ["clean", "-fd", "--", ...deleteTargets], { timeoutMs: 30_000 });
        }
        if (restoreTargets.length > 0) {
          await runGitCapture(root, ["checkout", "--", ...restoreTargets], { timeoutMs: 30_000 });
        }

        gitStatusCache = null;
        gitInfoCache = null;
        gitChangesCache = null;
        reply({ id: msg.id, ok: true, result: { discarded: true } });
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_discard_failed" });
      });
      return;
    }

    if (msg.type === "fs:gitCommit") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const info = await getGitRepoInfo(root);
        if (!info.isRepo) throw new Error("not_a_git_repo");
        const message = String(msg.message ?? "");
        if (!message.trim()) throw new Error("message_required");

        const tmpPath = path.join(tmpdir(), `xcoding-commit-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
        fs.writeFileSync(tmpPath, message, "utf8");
        try {
          await runGitCapture(root, ["commit", ...(msg.amend ? ["--amend"] : []), "-F", tmpPath], { timeoutMs: 45_000 });
          const hashRes = await runGitCapture(root, ["rev-parse", "HEAD"], { timeoutMs: 4000 });
          gitStatusCache = null;
          gitInfoCache = null;
          gitChangesCache = null;
          reply({ id: msg.id, ok: true, result: { commitHash: hashRes.stdout.trim() } });
        } finally {
          try {
            fs.rmSync(tmpPath, { force: true });
          } catch {
            // ignore
          }
        }
      })().catch((e) => {
        const code = (e as any)?.code;
        if (code === "ENOENT") reply({ id: msg.id, ok: false, error: "git_not_found" });
        else reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "git_commit_failed" });
      });
      return;
    }

    if (msg.type === "fs:searchFiles") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const query = String(msg.query ?? "").trim();
        const maxResults = typeof msg.maxResults === "number" ? Math.max(1, Math.min(1000, msg.maxResults)) : 100;
        if (!query) {
          reply({ id: msg.id, ok: true, result: { results: [] } });
          return;
        }
        const matcher = msg.useGitignore === false ? null : gitignore;
        const allFiles: { path: string; name: string; relativePath: string }[] = [];
        await walkDirectory(root, root, allFiles, maxResults * 10, matcher);
        const scored = allFiles
          .map((f) => {
            const nameScore = fuzzyMatch(query, f.name);
            const pathScore = fuzzyMatch(query, f.relativePath) * 0.8;
            return { ...f, score: Math.max(nameScore, pathScore) };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults)
          .map((r) => ({ path: r.path, name: r.name, relativePath: r.relativePath, score: r.score }));
        reply({ id: msg.id, ok: true, result: { results: scored } });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "search_files_failed" }));
      return;
    }

    if (msg.type === "fs:searchContent") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const query = String(msg.query ?? "").trim();
        const maxResults = typeof msg.maxResults === "number" ? Math.max(1, Math.min(5000, msg.maxResults)) : 500;
        const caseSensitive = Boolean(msg.caseSensitive);
        const wholeWord = Boolean(msg.wholeWord);
        const regex = Boolean(msg.regex);
        const useGitignore = msg.useGitignore !== false;
        const filePattern = typeof msg.filePattern === "string" ? msg.filePattern.trim() : "";

        if (!query) {
          reply({ id: msg.id, ok: true, result: { matches: [], totalMatches: 0, totalFiles: 0, truncated: false } });
          return;
        }

        const rgPath = await resolveRipgrepPath();
        if (!rgPath) {
          const fallback = await searchContentFallback({ rootPath: root, query, maxResults, caseSensitive, wholeWord, regex, useGitignore });
          reply({ id: msg.id, ok: true, result: fallback });
          return;
        }

        const { args, patternAfterDoubleDash } = getRgArgs({
          query,
          caseSensitive,
          wholeWord,
          regex,
          filePattern: filePattern || undefined,
          include: msg.include,
          exclude: msg.exclude,
          useGitignore
        });
        args.push("--");
        if (patternAfterDoubleDash) args.push(patternAfterDoubleDash);
        args.push(".");

        const matches: any[] = [];
        const fileSet = new Set<string>();
        let totalMatches = 0;
        let truncated = false;
        let stderr = "";

        await new Promise<void>((resolve) => {
          const proc = spawn(rgPath as string, args, { cwd: root!, stdio: ["ignore", "pipe", "pipe"] as any }) as any;
          let buffer = "";

          const timeoutId = setTimeout(() => {
            proc.stdout.removeAllListeners();
            proc.stderr.removeAllListeners();
            proc.removeAllListeners();
            proc.kill();
            truncated = true;
            resolve();
          }, 10_000);

          proc.stdout.on("data", (data: any) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const json = JSON.parse(line);
                if (json.type !== "match") continue;
                totalMatches += 1;
                const absPath = String(json.data.path.text ?? "");
                const relativePath = path.relative(root!, absPath).replace(/[\\\\]+/g, "/");
                fileSet.add(relativePath);
                if (matches.length < maxResults) {
                  const col0 = Number(json.data.submatches?.[0]?.start ?? 0);
                  matches.push({
                    path: absPath,
                    relativePath,
                    line: Number(json.data.line_number ?? 0),
                    column: col0 + 1,
                    content: String(json.data.lines?.text ?? "").replace(/\n$/, "")
                  });
                } else {
                  truncated = true;
                }
              } catch {
                // ignore parse errors
              }
            }
          });

          proc.stderr.on("data", (data: any) => {
            stderr += data.toString();
          });

          proc.on("close", () => {
            clearTimeout(timeoutId);
            if (buffer.trim()) {
              try {
                const json = JSON.parse(buffer);
                if (json.type === "match") {
                  totalMatches += 1;
                  const absPath = String(json.data.path.text ?? "");
                  const relativePath = path.relative(root!, absPath).replace(/[\\\\]+/g, "/");
                  fileSet.add(relativePath);
                  if (matches.length < maxResults) {
                    const col0 = Number(json.data.submatches?.[0]?.start ?? 0);
                    matches.push({
                      path: absPath,
                      relativePath,
                      line: Number(json.data.line_number ?? 0),
                      column: col0 + 1,
                      content: String(json.data.lines?.text ?? "").replace(/\n$/, "")
                    });
                  }
                }
              } catch {
                // ignore
              }
            }
            resolve();
          });

          proc.on("error", () => {
            clearTimeout(timeoutId);
            resolve();
          });
        });

        if (stderr) {
          // Keep stderr for debugging; return still-ok results.
        }

        reply({ id: msg.id, ok: true, result: { matches, totalMatches, totalFiles: fileSet.size, truncated } });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "search_content_failed" }));
      return;
    }

    if (msg.type === "fs:replaceContent") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const query = String(msg.query ?? "").trim();
        const replace = String(msg.replace ?? "");
        const caseSensitive = Boolean(msg.caseSensitive);
        const wholeWord = Boolean(msg.wholeWord);
        const regex = Boolean(msg.regex);
        const useGitignore = msg.useGitignore !== false;
        const filePattern = typeof msg.filePattern === "string" ? msg.filePattern.trim() : "";

        const maxFiles = typeof msg.maxFiles === "number" ? Math.max(1, Math.min(5000, msg.maxFiles)) : 200;
        const maxMatches = typeof msg.maxMatches === "number" ? Math.max(1, Math.min(200000, msg.maxMatches)) : 5000;
        const maxFileSize = typeof msg.maxFileSize === "string" ? msg.maxFileSize.trim() : "2M";

        if (!query) {
          reply({ id: msg.id, ok: true, result: { changedFiles: 0, changedMatches: 0, errors: [] } });
          return;
        }

        const re = buildSearchRegExp({ query, regex, wholeWord, caseSensitive });
        if (!re) throw new Error("invalid_search_pattern");

        const rg = await resolveRipgrepPath();
        const changed: string[] = [];
        const errors: Array<{ relativePath: string; error: string }> = [];
        let changedMatches = 0;

        const filesToProcess: string[] = [];
        if (rg) {
          const { args, patternAfterDoubleDash } = getRgArgs({
            query,
            caseSensitive,
            wholeWord,
            regex,
            filePattern: filePattern || undefined,
            include: msg.include,
            exclude: msg.exclude,
            useGitignore,
            maxFileSize
          });
          // Replace the json output mode with file listing.
          const filteredArgs = args.filter((a) => a !== "--json" && a !== "--line-number" && a !== "--column");
          filteredArgs.push("--files-with-matches");
          filteredArgs.push("--");
          if (patternAfterDoubleDash) filteredArgs.push(patternAfterDoubleDash);
          filteredArgs.push(".");

          const stdout = await new Promise<string>((resolve) => {
            const proc = spawn(rg as string, filteredArgs, { cwd: root!, stdio: ["ignore", "pipe", "pipe"] as any }) as any;
            let out = "";
            proc.stdout.on("data", (d: any) => (out += d.toString("utf8")));
            proc.on("close", () => resolve(out));
            proc.on("error", () => resolve(""));
          });
          for (const line of stdout.split("\n")) {
            const abs = line.trim();
            if (!abs) continue;
            filesToProcess.push(abs);
            if (filesToProcess.length >= maxFiles) break;
          }
        } else {
          const matcher = useGitignore ? gitignore : null;
          const files: { path: string; name: string; relativePath: string }[] = [];
          await walkDirectory(root, root, files, Math.max(5000, maxFiles * 50), matcher);
          for (const f of files) {
            if (!TEXT_EXTENSIONS.has(path.extname(f.name).toLowerCase())) continue;
            filesToProcess.push(f.path);
            if (filesToProcess.length >= maxFiles) break;
          }
        }

        for (const absPath of filesToProcess) {
          if (changed.length >= maxFiles) break;
          let text: string;
          try {
            const buf = fs.readFileSync(absPath);
            if (buf.includes(0)) continue; // binary
            text = buf.toString("utf8");
          } catch (e) {
            errors.push({ relativePath: path.relative(root!, absPath).replace(/[\\\\]+/g, "/"), error: e instanceof Error ? e.message : "read_failed" });
            continue;
          }

          re.lastIndex = 0;
          const matches = [...text.matchAll(re)];
          if (!matches.length) continue;

          if (changedMatches + matches.length > maxMatches) break;
          changedMatches += matches.length;

          const next = text.replace(re, replace);
          if (next === text) continue;

          try {
            fs.writeFileSync(absPath, next, "utf8");
            changed.push(path.relative(root!, absPath).replace(/[\\\\]+/g, "/"));
          } catch (e) {
            errors.push({ relativePath: path.relative(root!, absPath).replace(/[\\\\]+/g, "/"), error: e instanceof Error ? e.message : "write_failed" });
          }
        }

        reply({ id: msg.id, ok: true, result: { changedFiles: changed.length, changedMatches, changedPaths: changed, errors } });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "replace_content_failed" }));
      return;
    }

    if (msg.type === "lsp:didOpen") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const server = await ensureLspServer(msg.language);
        await server.initialized;
        const absPath = safeJoin(msg.relPath);
        const uri = fileUriFromAbsPath(absPath);
        const languageId = String(msg.languageId ?? msg.language);
        server.documents.set(msg.relPath, { uri, version: 1, languageId });
        server.connection.sendNotification("textDocument/didOpen", {
          textDocument: { uri, languageId, version: 1, text: String(msg.content ?? "") }
        });
        reply({ id: msg.id, ok: true, result: { opened: true } });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "lsp_open_failed" }));
      return;
    }

    if (msg.type === "lsp:didChange") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const server = await ensureLspServer(msg.language);
        await server.initialized;
        const doc = server.documents.get(msg.relPath);
        const absPath = safeJoin(msg.relPath);
        const uri = doc?.uri ?? fileUriFromAbsPath(absPath);
        const version = (doc?.version ?? 1) + 1;
        server.documents.set(msg.relPath, { uri, version, languageId: doc?.languageId ?? String(msg.language) });
        server.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text: String(msg.content ?? "") }]
        });
        reply({ id: msg.id, ok: true, result: { changed: true } });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "lsp_change_failed" }));
      return;
    }

    if (msg.type === "lsp:didClose") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const server = await ensureLspServer(msg.language);
        await server.initialized;
        const doc = server.documents.get(msg.relPath);
        if (doc) {
          server.connection.sendNotification("textDocument/didClose", { textDocument: { uri: doc.uri } });
          server.documents.delete(msg.relPath);
        }
        reply({ id: msg.id, ok: true, result: { closed: true } });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "lsp_close_failed" }));
      return;
    }

    if (msg.type === "lsp:request") {
      void (async () => {
        if (!root) throw new Error("not_initialized");
        const server = await ensureLspServer(msg.language);
        await server.initialized;
        const doc = server.documents.get(msg.relPath);
        const absPath = safeJoin(msg.relPath);
        const uri = doc?.uri ?? fileUriFromAbsPath(absPath);
        const params = (msg.params && typeof msg.params === "object" ? { ...(msg.params as any) } : {}) as any;
        if (params.textDocument && typeof params.textDocument === "object") params.textDocument = { ...params.textDocument, uri };
        else params.textDocument = { uri };
        const result = await server.connection.sendRequest(msg.method, params);
        reply({ id: msg.id, ok: true, result });
      })().catch((e) => reply({ id: msg.id, ok: false, error: e instanceof Error ? e.message : "lsp_request_failed" }));
      return;
    }

    throw new Error("unknown_request");
  } catch (e) {
    const id = typeof (msg as any)?.id === "string" ? (msg as any).id : "unknown";
    reply({ id, ok: false, error: e instanceof Error ? e.message : "error" });
  }
});

process.on("disconnect", () => {
  void stopWatcher();
});
