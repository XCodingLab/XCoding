import { clipboard, ipcMain, shell } from "electron";
import type { ProjectServiceRequestNoId } from "../shared/projectServiceProtocol";
import { sendToProjectService } from "../managers/projectServiceManager";
import { getProjectForSlot } from "../stores/projectsStore";

function ensureBoundProject(slot: number) {
  const project = getProjectForSlot(slot);
  if (!project) return { ok: false as const, reason: "project_unbound" as const };
  return { ok: true as const, project };
}

async function forwardToProjectService(slot: number, payload: ProjectServiceRequestNoId) {
  const bound = ensureBoundProject(slot);
  if (!bound.ok) return bound;
  const res = await sendToProjectService(bound.project.id, payload);
  if (!res.ok) return { ok: false as const, reason: res.error as string };
  return { ok: true as const, result: res.result };
}

export function registerProjectIpc() {
  ipcMain.handle("project:fsReadFile", async (_event, { slot, path: relPath }: { slot: number; path: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:readFile", relPath });
    if (!res.ok) return res;
    return { ok: true, content: String((res.result as any)?.content ?? "") };
  });

  ipcMain.handle("project:fsWriteFile", async (_event, { slot, path: relPath, content }: { slot: number; path: string; content: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:writeFile", relPath, content });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:fsListDir", async (_event, { slot, dir }: { slot: number; dir: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:listDir", relDir: dir });
    if (!res.ok) return res;
    return { ok: true, entries: (res.result as any)?.entries ?? [] };
  });

  ipcMain.handle("project:fsStat", async (_event, { slot, path: relPath }: { slot: number; path: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:stat", relPath });
    if (!res.ok) return res;
    return { ok: true, ...(res.result as any) };
  });

  ipcMain.handle("project:searchPaths", async (_event, { slot, query, limit }: { slot: number; query: string; limit?: number }) => {
    const res = await forwardToProjectService(slot, { type: "fs:searchPaths", query, limit });
    if (!res.ok) return res;
    return { ok: true, results: (res.result as any)?.results ?? [] };
  });

  ipcMain.handle("project:gitStatus", async (_event, { slot, maxEntries }: { slot: number; maxEntries?: number }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitStatus", maxEntries });
    if (!res.ok) return res;
    return { ok: true, entries: (res.result as any)?.entries ?? {} };
  });

  ipcMain.handle("project:gitInfo", async (_event, { slot }: { slot: number }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitInfo" });
    if (!res.ok) return res;
    return { ok: true, ...(res.result as any) };
  });

  ipcMain.handle("project:gitChanges", async (_event, { slot, maxEntries }: { slot: number; maxEntries?: number }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitChanges", maxEntries });
    if (!res.ok) return res;
    return { ok: true, ...(res.result as any) };
  });

  ipcMain.handle("project:gitDiff", async (_event, { slot, path, mode }: { slot: number; path: string; mode: "working" | "staged" }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitDiff", path, mode });
    if (!res.ok) return res;
    return { ok: true, diff: String((res.result as any)?.diff ?? ""), truncated: Boolean((res.result as any)?.truncated) };
  });

  ipcMain.handle("project:gitFileDiff", async (_event, { slot, path, mode }: { slot: number; path: string; mode: "working" | "staged" }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitFileDiff", path, mode });
    if (!res.ok) return res;
    return {
      ok: true,
      original: String((res.result as any)?.original ?? ""),
      modified: String((res.result as any)?.modified ?? ""),
      truncated: Boolean((res.result as any)?.truncated),
      isBinary: Boolean((res.result as any)?.isBinary)
    };
  });

  ipcMain.handle("project:gitStage", async (_event, { slot, paths }: { slot: number; paths: string[] }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitStage", paths });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:gitUnstage", async (_event, { slot, paths }: { slot: number; paths: string[] }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitUnstage", paths });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:gitDiscard", async (_event, { slot, paths, includeUntracked }: { slot: number; paths: string[]; includeUntracked?: boolean }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitDiscard", paths, includeUntracked });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:gitCommit", async (_event, { slot, message, amend }: { slot: number; message: string; amend?: boolean }) => {
    const res = await forwardToProjectService(slot, { type: "fs:gitCommit", message, amend });
    if (!res.ok) return res;
    return { ok: true, commitHash: String((res.result as any)?.commitHash ?? "") };
  });

  ipcMain.handle(
    "project:searchFiles",
    async (_event, { slot, query, maxResults }: { slot: number; query: string; maxResults?: number }) => {
      const res = await forwardToProjectService(slot, { type: "fs:searchFiles", query, maxResults });
      if (!res.ok) return res;
      return { ok: true, results: (res.result as any)?.results ?? [] };
    }
  );

  ipcMain.handle(
    "project:searchContent",
    async (_event, { slot, query, maxResults }: { slot: number; query: string; maxResults?: number }) => {
      const res = await forwardToProjectService(slot, { type: "fs:searchContent", query, maxResults });
      if (!res.ok) return res;
      return { ok: true, result: res.result };
    }
  );

  ipcMain.handle(
    "project:replaceContent",
    async (
      _event,
      {
        slot,
        query,
        replace,
        caseSensitive,
        wholeWord,
        regex,
        filePattern,
        include,
        exclude,
        useGitignore,
        maxFiles,
        maxMatches,
        maxFileSize
      }: {
        slot: number;
        query: string;
        replace: string;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        regex?: boolean;
        filePattern?: string;
        include?: string[];
        exclude?: string[];
        useGitignore?: boolean;
        maxFiles?: number;
        maxMatches?: number;
        maxFileSize?: string;
      }
    ) => {
      const res = await forwardToProjectService(slot, {
        type: "fs:replaceContent",
        query,
        replace,
        caseSensitive,
        wholeWord,
        regex,
        filePattern,
        include,
        exclude,
        useGitignore,
        maxFiles,
        maxMatches,
        maxFileSize
      });
      if (!res.ok) return res;
      return { ok: true, result: res.result };
    }
  );

  ipcMain.handle("project:fsDeleteFile", async (_event, { slot, path: rel }: { slot: number; path: string }) => {
    const bound = ensureBoundProject(slot);
    if (!bound.ok) return bound;

    const del = await sendToProjectService(bound.project.id, { type: "fs:deleteFile", relPath: rel });
    if (!del.ok) return { ok: false, reason: del.error };

    const stat = await sendToProjectService(bound.project.id, { type: "fs:stat", relPath: rel });
    if (stat.ok && (stat.result as any)?.exists) return { ok: false, reason: "delete_failed_file_still_exists" };
    return { ok: true };
  });

  ipcMain.handle("project:fsMkdir", async (_event, { slot, dir }: { slot: number; dir: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:mkdir", relDir: dir });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:fsRename", async (_event, { slot, from, to }: { slot: number; from: string; to: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:rename", from, to });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:fsDeleteDir", async (_event, { slot, dir }: { slot: number; dir: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:deleteDir", relDir: dir });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:tsDiagnostics", async (_event, { slot, path: relPath, content }: { slot: number; path: string; content: string }) => {
    const res = await forwardToProjectService(slot, { type: "lang:ts:diagnostics", relPath, content });
    if (!res.ok) return res;
    return { ok: true, diagnostics: (res.result as any)?.diagnostics ?? [] };
  });

  ipcMain.handle(
    "project:lspDidOpen",
    async (
      _event,
      {
        slot,
        language,
        path: relPath,
        languageId,
        content
      }: { slot: number; language: "python" | "go"; path: string; languageId: string; content: string }
    ) => {
      const res = await forwardToProjectService(slot, { type: "lsp:didOpen", language, relPath, languageId, content });
      if (!res.ok) return res;
      return { ok: true };
    }
  );

  ipcMain.handle("project:lspDidChange", async (_event, { slot, language, path: relPath, content }: { slot: number; language: "python" | "go"; path: string; content: string }) => {
    const res = await forwardToProjectService(slot, { type: "lsp:didChange", language, relPath, content });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle("project:lspDidClose", async (_event, { slot, language, path: relPath }: { slot: number; language: "python" | "go"; path: string }) => {
    const res = await forwardToProjectService(slot, { type: "lsp:didClose", language, relPath });
    if (!res.ok) return res;
    return { ok: true };
  });

  ipcMain.handle(
    "project:lspRequest",
    async (
      _event,
      { slot, language, method, path: relPath, params }: { slot: number; language: "python" | "go"; method: string; path: string; params?: unknown }
    ) => {
      const res = await forwardToProjectService(slot, { type: "lsp:request", language, method, relPath, params });
      if (!res.ok) return res;
      return { ok: true, result: res.result };
    }
  );

  ipcMain.handle("fs:readFile", async (_event, { slot, path: relPath }: { slot: number; path: string }) => {
    const res = await forwardToProjectService(slot, { type: "fs:readFile", relPath });
    if (!res.ok) return res;
    return { ok: true, content: String((res.result as any)?.content ?? "") };
  });

  ipcMain.handle("os:copyText", (_event, { text }: { text: string }) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "copy_failed" };
    }
  });

  ipcMain.handle("os:openExternal", async (_event, { url }: { url: string }) => {
    try {
      const target = String(url ?? "").trim();
      if (!target) return { ok: false, reason: "missing_url" };
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return { ok: false, reason: "invalid_url" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "unsupported_protocol" };
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "open_external_failed" };
    }
  });
}
