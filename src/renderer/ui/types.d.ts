export {};

declare global {
  interface Window {
    xcoding: {
      terminal: {
        create: (options?: { slot?: number }) => Promise<{
          ok: boolean;
          sessionId?: string;
          reason?: string;
          cwd?: string;
          shell?: string;
          kind?: "pty" | "proc";
          lastError?: string;
        }>;
        write: (sessionId: string, data: string) => Promise<{ ok: boolean }>;
        resize: (sessionId: string, cols: number, rows: number) => Promise<{ ok: boolean }>;
        dispose: (sessionId: string) => Promise<{ ok: boolean }>;
        getBuffer: (sessionId: string, maxBytes?: number) => Promise<{ ok: boolean; data?: string }>;
        onData: (listener: (payload: { sessionId: string; data: string }) => void) => () => void;
      };
      preview: {
        create: (payload: { previewId: string; url: string }) => Promise<{ ok: boolean; reason?: string }>;
        show: (payload: { previewId: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean; reason?: string }>;
        hide: (payload: { previewId: string }) => Promise<{ ok: boolean; reason?: string }>;
        setBounds: (payload: { previewId: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean; reason?: string }>;
        navigate: (payload: { previewId: string; url: string }) => Promise<{ ok: boolean; reason?: string }>;
        reload: (payload: { previewId: string }) => Promise<{ ok: boolean; reason?: string }>;
        destroy: (payload: { previewId: string }) => Promise<{ ok: boolean; reason?: string }>;
        setPreserveLog: (payload: { previewId: string; preserveLog: boolean }) => Promise<{ ok: boolean; reason?: string }>;
        setEmulation: (payload: { previewId: string; mode: "desktop" | "phone" | "tablet" }) => Promise<{ ok: boolean; reason?: string }>;
        networkGetEntry: (payload: { previewId: string; requestId: string }) => Promise<
          | {
              ok: true;
              entry: {
                requestId: string;
                url: string;
                method: string;
                type: string;
                status: number;
                statusText: string;
                mimeType: string;
                startedAt: number;
                finishedAt: number;
                durationMs: number;
                sizeBytes: number;
                errorText: string;
                requestHeaders: Record<string, string>;
                requestPostData: string;
                responseHeaders: Record<string, string>;
              };
            }
          | { ok: false; reason: string }
        >;
        networkGetResponseBody: (payload: { previewId: string; requestId: string }) => Promise<
          | { ok: true; body: string; base64Encoded: boolean; sizeBytes: number; mimeType: string }
          | { ok: false; reason: string; sizeBytes?: number }
        >;
        networkBuildCurl: (payload: { previewId: string; requestId: string }) => Promise<{ ok: true; curl: string } | { ok: false; reason: string }>;
        networkClearBrowserCache: (payload: { previewId: string }) => Promise<{ ok: boolean; reason?: string }>;
        onConsole: (listener: (payload: { previewId: string; level: string; text: string; timestamp: number }) => void) => () => void;
        onNetwork: (
          listener: (payload: {
            previewId: string;
            requestId: string;
            url: string;
            status: number;
            method: string;
            type: string;
            timestamp: number;
            durationMs: number | null;
            sizeBytes: number | null;
            errorText: string | null;
          }) => void
        ) => () => void;
        onResetLogs: (listener: (payload: { previewId: string }) => void) => () => void;
      };
      projects: {
        get: () => Promise<{
          ok: boolean;
          state: {
            schemaVersion: 3;
            slotOrder: number[];
            slots: Array<{ slot: number; projectId?: string }>;
            projects: Record<
              string,
              {
                id: string;
                path: string;
                name: string;
                lastOpenedAt: number;
                uiLayout?: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean };
                workflow?: { stage: "idea" | "auto" | "preview" | "develop" | "review"; lastUpdatedAt?: number };
              }
            >;
          };
        }>;
        getWorkflow: (projectId: string) => Promise<{
          ok: boolean;
          workflow?: { stage: "idea" | "auto" | "preview" | "develop" | "review"; lastUpdatedAt?: number };
          reason?: string;
        }>;
        setWorkflow: (
          projectId: string,
          workflow: Partial<{ stage: "idea" | "auto" | "preview" | "develop" | "review"; lastUpdatedAt?: number }>
        ) => Promise<{ ok: boolean; reason?: string }>;
        setSlotPath: (slot: number, projectPath: string) => Promise<{ ok: boolean; projectId?: string; reason?: string }>;
        bindCwd: (slot: number) => Promise<{ ok: boolean; projectId?: string; reason?: string }>;
        openFolder: (slot: number) => Promise<{ ok: boolean; projectId?: string; reason?: string; canceled?: boolean }>;
        unbindSlot: (slot: number) => Promise<{ ok: boolean; reason?: string }>;
        reorderSlots: (slotOrder: number[]) => Promise<{ ok: boolean; reason?: string }>;
        setUiLayout: (
          projectId: string,
          layout: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean }
        ) => Promise<{ ok: boolean; reason?: string }>;
        setActiveSlot: (slot: number) => Promise<{ ok: boolean; reason?: string }>;
        onSwitchSlot: (listener: (payload: { slot: number }) => void) => () => void;
        onState: (
          listener: (payload: {
            state: {
              schemaVersion: 3;
              slotOrder: number[];
              slots: Array<{ slot: number; projectId?: string }>;
              projects: Record<
                string,
                {
                  id: string;
                  path: string;
                  name: string;
                  lastOpenedAt: number;
                  uiLayout?: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean };
                  workflow?: { stage: "idea" | "auto" | "preview" | "develop" | "review"; lastUpdatedAt?: number };
                }
              >;
            };
          }) => void
        ) => () => void;
      };
      window: {
        create: (payload?: { slot?: number; mode?: "single" | "multi" }) => Promise<{ ok: boolean; windowId?: number; reused?: boolean; reason?: string }>;
        getDetachedSlots: () => Promise<{ ok: boolean; slots?: number[]; reason?: string }>;
        minimize: () => Promise<{ ok: boolean; reason?: string }>;
        maximizeToggle: () => Promise<{ ok: boolean; maximized?: boolean; reason?: string }>;
        close: () => Promise<{ ok: boolean; reason?: string }>;
        onDetachedSlots: (listener: (payload: { slots: number[] }) => void) => () => void;
      };
      events: {
        onProjectEvent: (listener: (payload: { projectId: string; type: string; [k: string]: unknown }) => void) => () => void;
      };
      ai: {
        onStatus: (listener: (payload: { slot: number; status: "idle" | "running" | "done" | "error"; timestamp: number }) => void) => () => void;
        onStream: (listener: (payload: { slot?: number; kind: "chunk" | "done" | "error"; id: string; text?: string; error?: string }) => void) => () => void;
        stageEdits: (payload: { slot: number; fileEdits: Array<{ path: string; content: string }> }) => Promise<{ ok: boolean; patchId?: string }>;
        applyAll: (payload: { slot: number }) => Promise<{ ok: boolean; appliedFiles?: string[]; reason?: string }>;
        revertLast: (payload: { slot: number }) => Promise<{ ok: boolean; revertedFiles?: string[]; reason?: string }>;
        getStaging: (payload: { slot: number }) => Promise<{
          ok: boolean;
          staging: Array<{
            patchId: string;
            fileEdits: Array<{ path: string }>;
            createdAt: number;
            appliedAt?: number;
            revertedAt?: number;
          }>;
        }>;
        chatStart: (payload: { slot: number; requestId: string; messages: Array<{ role: string; content: string }> }) => Promise<{ ok: boolean; reason?: string }>;
        chatCancel: (payload: { slot: number; requestId: string }) => Promise<{ ok: boolean; reason?: string }>;
      };
      codex: {
        ensureStarted: () => Promise<{ ok: boolean; reason?: string }>;
        getStatus: () => Promise<{
          ok: boolean;
          status?: { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string };
          lastStderr?: string;
          codexHome?: string | null;
          reason?: string;
        }>;
        threadList: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        threadStart: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        threadResume: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        threadArchive: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        sessionRead: (payload: { path: string }) => Promise<{ ok: boolean; result?: { turns: any[] }; reason?: string }>;
        writeImageAttachment: (payload: {
          bytes: ArrayBuffer;
          mime: string;
          suggestedName?: string;
        }) => Promise<{ ok: boolean; result?: { path: string; byteLength?: number; mime?: string }; reason?: string }>;
        readLocalImageAsDataUrl: (payload: {
          path: string;
        }) => Promise<{ ok: boolean; result?: { dataUrl: string; mime?: string; byteLength?: number }; reason?: string }>;
        turnStart: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        turnInterrupt: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        turnRevert: (payload: { threadId: string; turnId: string }) => Promise<{ ok: boolean; reason?: string }>;
        turnApply: (payload: { threadId: string; turnId: string }) => Promise<{ ok: boolean; reason?: string }>;
        turnFileDiff: (payload: {
          threadId: string;
          turnId: string;
          path: string;
          maxBytes?: number;
        }) => Promise<
          | { ok: true; original: string; modified: string; truncated: boolean; isBinary: boolean }
          | { ok: false; reason: string }
        >;
        reviewStart: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        modelList: (payload?: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        skillsList: (payload?: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        mcpServerStatusList: (payload?: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        configRead: (payload?: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        configValueWrite: (payload: any) => Promise<{ ok: boolean; result?: any; reason?: string }>;
        restart: () => Promise<{ ok: boolean; reason?: string }>;
        respond: (payload: { id: number; result?: any; error?: any }) => Promise<{ ok: boolean; reason?: string }>;
        onEvent: (listener: (payload: any) => void) => () => void;
        onRequest: (listener: (payload: any) => void) => () => void;
      };
      claude: {
        ensureStarted: (payload: {
          slot: number;
          projectRootPath?: string;
          sessionId?: string | null;
          permissionMode?: string;
          forkSession?: boolean;
        }) => Promise<{ ok: boolean; sessionId?: string | null; permissionMode?: string; reason?: string }>;
        send: (payload: {
          slot: number;
          projectRootPath: string;
          sessionId?: string | null;
          permissionMode?: string;
          forkSession?: boolean;
          content: any;
          isSynthetic?: boolean;
        }) => Promise<{ ok: boolean; sessionId?: string | null; permissionMode?: string; reason?: string }>;
        supportedCommands: (payload: {
          slot: number;
          projectRootPath: string;
          sessionId?: string | null;
          permissionMode?: string;
        }) => Promise<
          | { ok: true; commands: Array<{ name: string; description: string; argumentHint: string }> }
          | { ok: false; reason: string }
        >;
        supportedModels: (payload: {
          slot: number;
          projectRootPath: string;
          sessionId?: string | null;
          permissionMode?: string;
        }) => Promise<
          | { ok: true; models: Array<{ value: string; displayName: string; description: string }> }
          | { ok: false; reason: string }
        >;
        accountInfo: (payload: {
          slot: number;
          projectRootPath: string;
          sessionId?: string | null;
          permissionMode?: string;
        }) => Promise<
          | {
              ok: true;
              accountInfo: { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string };
            }
          | { ok: false; reason: string }
        >;
        setModel: (payload: { slot: number; model?: string }) => Promise<{ ok: boolean; reason?: string }>;
        setMaxThinkingTokens: (payload: { slot: number; maxThinkingTokens: number | null }) => Promise<{ ok: boolean; reason?: string }>;
        buildOpenInTerminalCommand: (payload: {
          slot: number;
          resumeSessionId?: string | null;
          initialInput?: string | null;
          extraArgs?: string[];
        }) => Promise<{ ok: boolean; command?: string; reason?: string; slot?: number; claudeCodeVersion?: string }>;
        getStatus: (payload: { slot: number }) => Promise<{
          ok: boolean;
          status?: { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string };
          slot?: number;
          sessionId?: string | null;
          permissionMode?: string;
          reason?: string;
        }>;
        sendUserMessage: (payload: {
          slot: number;
          content: unknown;
          isSynthetic?: boolean;
          projectRootPath?: string;
          sessionId?: string | null;
          permissionMode?: string;
          forkSession?: boolean;
        }) => Promise<{ ok: boolean; reason?: string; sessionId?: string | null; permissionMode?: string }>;
        interrupt: (payload: { slot: number }) => Promise<{ ok: boolean; reason?: string }>;
        close: (payload: { slot: number }) => Promise<{ ok: boolean; reason?: string }>;
        setPermissionMode: (payload: { slot: number; mode: string }) => Promise<{ ok: boolean; reason?: string }>;
        respondToolPermission: (payload: {
          requestId: string;
          behavior: "allow" | "deny";
          updatedInput?: any;
          updatedPermissions?: any;
          message?: string;
          interrupt?: boolean;
        }) => Promise<{ ok: boolean; reason?: string }>;
        historyList: (payload: { projectRootPath: string }) => Promise<{
          ok: boolean;
          sessions?: Array<{ sessionId: string; fileName?: string; updatedAtMs: number; preview?: string }>;
          reason?: string;
        }>;
        sessionRead: (payload: { projectRootPath: string; sessionId: string }) => Promise<{ ok: boolean; thread?: any; reason?: string; debug?: any }>;
        turnFileDiff: (payload: {
          projectRootPath: string;
          sessionId: string;
          absPath: string;
        }) => Promise<
          | {
              ok: true;
              original: string;
              modified: string;
              backupName?: string;
              messageId?: string;
              relPath?: string;
              added?: number;
              removed?: number;
              unifiedDiff?: string;
              unifiedTruncated?: boolean;
            }
          | { ok: false; reason: string; messageId?: string }
        >;
        mcpServerStatus: (payload: { slot: number }) => Promise<{ ok: boolean; servers?: Array<{ name: string; status: string }>; reason?: string }>;
        forkSession: (payload: { slot: number; projectRootPath: string; sessionId: string; permissionMode?: string }) => Promise<{
          ok: boolean;
          sessionId?: string;
          reason?: string;
        }>;
        latestSnapshotFiles: (payload: { projectRootPath: string; sessionId: string }) => Promise<{
          ok: boolean;
          files?: Array<{
            absPath: string;
            backupName: string;
            relPath?: string;
            added?: number;
            removed?: number;
            truncated?: boolean;
            error?: string;
          }>;
          messageId?: string;
          reason?: string;
        }>;
        revertFileFromBackup: (payload: { absPath: string; content: string }) => Promise<{ ok: boolean; reason?: string }>;
        onEvent: (listener: (payload: any) => void) => () => void;
        onRequest: (listener: (payload: any) => void) => () => void;
      };
      project: {
        readFile: (payload: { slot: number; path: string }) => Promise<{ ok: boolean; content?: string; reason?: string }>;
        writeFile: (payload: { slot: number; path: string; content: string }) => Promise<{ ok: boolean; reason?: string }>;
        listDir: (payload: { slot: number; dir: string }) => Promise<{
          ok: boolean;
          entries?: Array<{ name: string; kind: "dir" | "file"; ignored?: boolean }>;
          reason?: string;
        }>;
        stat: (payload: { slot: number; path: string }) => Promise<{
          ok: boolean;
          exists?: boolean;
          isFile?: boolean;
          isDirectory?: boolean;
          size?: number;
          mtimeMs?: number;
          reason?: string;
        }>;
        searchPaths: (payload: { slot: number; query: string; limit?: number }) => Promise<{ ok: boolean; results?: string[]; reason?: string }>;
        gitStatus: (payload: { slot: number; maxEntries?: number }) => Promise<{
          ok: boolean;
          entries?: Record<string, string>;
          reason?: string;
        }>;
        gitInfo: (payload: { slot: number }) => Promise<{
          ok: boolean;
          isRepo?: boolean;
          repoRoot?: string;
          branch?: string;
          reason?: string;
        }>;
        gitChanges: (payload: { slot: number; maxEntries?: number }) => Promise<{
          ok: boolean;
          isRepo?: boolean;
          repoRoot?: string;
          branch?: string;
          staged?: string[];
          unstaged?: string[];
          untracked?: string[];
          conflict?: string[];
          statusByPath?: Record<string, string>;
          reason?: string;
        }>;
        gitDiff: (payload: { slot: number; path: string; mode: "working" | "staged" }) => Promise<{
          ok: boolean;
          diff?: string;
          truncated?: boolean;
          reason?: string;
        }>;
        gitFileDiff: (payload: { slot: number; path: string; mode: "working" | "staged" }) => Promise<{
          ok: boolean;
          original?: string;
          modified?: string;
          truncated?: boolean;
          isBinary?: boolean;
          reason?: string;
        }>;
        gitStage: (payload: { slot: number; paths: string[] }) => Promise<{ ok: boolean; reason?: string }>;
        gitUnstage: (payload: { slot: number; paths: string[] }) => Promise<{ ok: boolean; reason?: string }>;
        gitDiscard: (payload: { slot: number; paths: string[]; includeUntracked?: boolean }) => Promise<{ ok: boolean; reason?: string }>;
        gitCommit: (payload: { slot: number; message: string; amend?: boolean }) => Promise<{ ok: boolean; commitHash?: string; reason?: string }>;
        searchFiles: (payload: { slot: number; query: string; maxResults?: number }) => Promise<{
          ok: boolean;
          results?: Array<{ path: string; name: string; relativePath: string; score: number }>;
          reason?: string;
        }>;
        searchContent: (payload: { slot: number; query: string; maxResults?: number }) => Promise<{
          ok: boolean;
          result?: {
            matches: Array<{ path: string; relativePath: string; line: number; column: number; content: string }>;
            totalMatches: number;
            totalFiles: number;
            truncated: boolean;
          };
          reason?: string;
        }>;
        replaceContent: (payload: {
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
        }) => Promise<{
          ok: boolean;
          result?: {
            changedFiles: number;
            changedMatches: number;
            changedPaths: string[];
            errors: Array<{ relativePath: string; error: string }>;
          };
          reason?: string;
        }>;
        deleteFile: (payload: { slot: number; path: string }) => Promise<{ ok: boolean; reason?: string }>;
        mkdir: (payload: { slot: number; dir: string }) => Promise<{ ok: boolean; reason?: string }>;
        rename: (payload: { slot: number; from: string; to: string }) => Promise<{ ok: boolean; reason?: string }>;
        deleteDir: (payload: { slot: number; dir: string }) => Promise<{ ok: boolean; reason?: string }>;
        tsDiagnostics: (payload: { slot: number; path: string; content: string }) => Promise<{
          ok: boolean;
          diagnostics?: Array<{ code: number; message: string; line: number; column: number; category: string }>;
          reason?: string;
        }>;
        lspDidOpen: (payload: { slot: number; language: "python" | "go"; path: string; languageId: string; content: string }) => Promise<{ ok: boolean; reason?: string }>;
        lspDidChange: (payload: { slot: number; language: "python" | "go"; path: string; content: string }) => Promise<{ ok: boolean; reason?: string }>;
        lspDidClose: (payload: { slot: number; language: "python" | "go"; path: string }) => Promise<{ ok: boolean; reason?: string }>;
        lspRequest: (payload: { slot: number; language: "python" | "go"; method: string; path: string; params?: unknown }) => Promise<{ ok: boolean; result?: any; reason?: string }>;
      };
      fs: {
        readFile: (payload: { slot: number; path: string }) => Promise<{ ok: boolean; content?: string; reason?: string }>;
      };
      settings: {
        get: () => Promise<{
          ui: {
            language: "en-US" | "zh-CN";
            theme: "dark" | "light";
            themePackId: string;
            layout?: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean };
          };
          ai: { autoApplyAll: boolean; apiBase: string; apiKey: string; model: string };
        }>;
        setLanguage: (language: "en-US" | "zh-CN") => Promise<{ ok: boolean }>;
        setTheme: (theme: "dark" | "light") => Promise<{ ok: boolean }>;
        setThemePack: (id: string) => Promise<{ ok: boolean }>;
        setAutoApply: (enabled: boolean) => Promise<{ ok: boolean }>;
        setAiConfig: (payload: { apiBase: string; apiKey: string; model: string }) => Promise<{ ok: boolean }>;
        setLayout: (payload: { explorerWidth: number; chatWidth: number; isExplorerVisible: boolean; isChatVisible: boolean }) => Promise<{ ok: boolean }>;
      };
      themes: {
        list: () => Promise<Array<{ id: string; name: string; appearance: "dark" | "light"; source: "builtin" | "user" }>>;
        getResolved: (id: string) => Promise<{
          id: string;
          name: string;
          appearance: "dark" | "light";
          cssVars: Record<string, string>;
          monacoThemeName: string;
          monacoThemeData?: {
            base: "vs" | "vs-dark";
            inherit: boolean;
            rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
            colors: Record<string, string>;
          };
          extraCssText?: string;
        }>;
        openDir: () => Promise<{ ok: boolean; path: string }>;
        openThemeDir: (id: string) => Promise<{ ok: boolean; path: string }>;
        importZip: () => Promise<
          | { ok: true; canceled: true }
          | { ok: true; themeId: string; didReplace: boolean }
          | { ok: false; reason: string; themeId?: string }
        >;
      };
      os: {
        copyText: (text: string) => Promise<{ ok: boolean; reason?: string }>;
        openExternal: (url: string) => Promise<{ ok: boolean; reason?: string }>;
      };
    };
  }
}
