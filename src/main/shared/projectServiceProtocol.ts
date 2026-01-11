export type LspLanguage = "python" | "go";

export type ProjectServiceRequest =
  | { id: string; type: "init"; projectPath: string }
  | { id: string; type: "fs:readFile"; relPath: string }
  | { id: string; type: "fs:writeFile"; relPath: string; content: string }
  | { id: string; type: "fs:listDir"; relDir: string }
  | { id: string; type: "fs:searchPaths"; query: string; limit?: number }
  | { id: string; type: "fs:gitStatus"; maxEntries?: number }
  | { id: string; type: "fs:gitInfo" }
  | { id: string; type: "fs:gitChanges"; maxEntries?: number }
  | { id: string; type: "fs:gitDiff"; path: string; mode: "working" | "staged"; maxBytes?: number }
  | { id: string; type: "fs:gitFileDiff"; path: string; mode: "working" | "staged"; maxBytes?: number }
  | { id: string; type: "fs:gitStage"; paths: string[] }
  | { id: string; type: "fs:gitUnstage"; paths: string[] }
  | { id: string; type: "fs:gitDiscard"; paths: string[]; includeUntracked?: boolean }
  | { id: string; type: "fs:gitCommit"; message: string; amend?: boolean }
  | { id: string; type: "fs:searchFiles"; query: string; maxResults?: number }
  | { id: string; type: "fs:searchContent"; query: string; maxResults?: number }
  | {
      id: string;
      type: "fs:replaceContent";
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
  | { id: string; type: "fs:deleteFile"; relPath: string }
  | { id: string; type: "fs:deleteDir"; relDir: string }
  | { id: string; type: "fs:stat"; relPath: string }
  | { id: string; type: "fs:mkdir"; relDir: string }
  | { id: string; type: "fs:rename"; from: string; to: string }
  | { id: string; type: "watcher:start" }
  | { id: string; type: "watcher:stop" }
  | { id: string; type: "watcher:setPaused"; paused: boolean }
  | { id: string; type: "lang:ts:diagnostics"; relPath: string; content: string }
  | { id: string; type: "lsp:didOpen"; language: LspLanguage; relPath: string; languageId: string; content: string }
  | { id: string; type: "lsp:didChange"; language: LspLanguage; relPath: string; content: string }
  | { id: string; type: "lsp:didClose"; language: LspLanguage; relPath: string }
  | { id: string; type: "lsp:request"; language: LspLanguage; method: string; relPath: string; params?: unknown };

export type ProjectServiceResponse = { id: string; ok: true; result: any } | { id: string; ok: false; error: string };

type WithoutId<T> = T extends any ? Omit<T, "id"> : never;
export type ProjectServiceRequestNoId = WithoutId<ProjectServiceRequest>;
