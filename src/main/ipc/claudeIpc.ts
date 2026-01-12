import { ipcMain } from "electron";
import {
  buildClaudeOpenInTerminalCommand,
  closeClaude,
  ensureClaudeStarted,
  getClaudeAccountInfo,
  getClaudeStatus,
  getClaudeSupportedCommands,
  getClaudeSupportedModels,
  interruptClaude,
  respondToClaudeToolPermission,
  runClaudeTurn,
  setClaudeMaxThinkingTokens,
  setClaudeModel,
  setClaudePermissionMode,
  getClaudeMcpServerStatus,
  type ClaudePermissionMode
} from "../claude/claudeManager";
import { listClaudeSessions } from "../claude/history/sessionIndex";
import { readClaudeSession } from "../claude/history/sessionReader";
import { claudeLatestSnapshotFiles, claudeTurnFileDiff } from "../claude/diff/turnFileDiff";
import fs from "node:fs/promises";

export function registerClaudeIpc() {
  ipcMain.handle("claude:ensureStarted", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const projectRootPath = String(params?.projectRootPath ?? "");
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      const permissionMode = params?.permissionMode as ClaudePermissionMode | undefined;
      const forkSession = typeof params?.forkSession === "boolean" ? Boolean(params.forkSession) : undefined;
      const res = await ensureClaudeStarted({ slot, projectRootPath, sessionId, permissionMode, forkSession });
      return res;
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_ensure_started_failed" };
    }
  });

  ipcMain.handle("claude:supportedCommands", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const projectRootPath = String(params?.projectRootPath ?? "");
      if (!projectRootPath) return { ok: false, reason: "missing_projectRootPath" };
      const permissionMode = params?.permissionMode as ClaudePermissionMode | undefined;
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      await ensureClaudeStarted({ slot, projectRootPath, sessionId, permissionMode });
      return await getClaudeSupportedCommands(slot);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_supported_commands_failed" };
    }
  });

  ipcMain.handle("claude:supportedModels", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const projectRootPath = String(params?.projectRootPath ?? "");
      if (!projectRootPath) return { ok: false, reason: "missing_projectRootPath" };
      const permissionMode = params?.permissionMode as ClaudePermissionMode | undefined;
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      await ensureClaudeStarted({ slot, projectRootPath, sessionId, permissionMode });
      return await getClaudeSupportedModels(slot);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_supported_models_failed" };
    }
  });

  ipcMain.handle("claude:accountInfo", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const projectRootPath = String(params?.projectRootPath ?? "");
      if (!projectRootPath) return { ok: false, reason: "missing_projectRootPath" };
      const permissionMode = params?.permissionMode as ClaudePermissionMode | undefined;
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      await ensureClaudeStarted({ slot, projectRootPath, sessionId, permissionMode });
      return await getClaudeAccountInfo(slot);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_account_info_failed" };
    }
  });

  ipcMain.handle("claude:setModel", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const model = typeof params?.model === "string" ? params.model : undefined;
      const res = await setClaudeModel({ slot, model });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_set_model_failed" };
    }
  });

  ipcMain.handle("claude:setMaxThinkingTokens", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const raw = params?.maxThinkingTokens;
      const maxThinkingTokens = raw === null ? null : typeof raw === "number" ? raw : raw === undefined ? null : Number(raw);
      const res = await setClaudeMaxThinkingTokens({ slot, maxThinkingTokens });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_set_max_thinking_tokens_failed" };
    }
  });

  ipcMain.handle("claude:buildOpenInTerminalCommand", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const resumeSessionId = typeof params?.resumeSessionId === "string" ? params.resumeSessionId : null;
      const initialInput = typeof params?.initialInput === "string" ? params.initialInput : null;
      const extraArgs = Array.isArray(params?.extraArgs) ? params.extraArgs.map((a: any) => String(a)) : undefined;
      return buildClaudeOpenInTerminalCommand({ slot, resumeSessionId, initialInput, extraArgs });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_build_terminal_command_failed" };
    }
  });

  ipcMain.handle("claude:getStatus", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      return { ok: true, ...getClaudeStatus(slot) };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_status_failed" };
    }
  });

  ipcMain.handle("claude:sendUserMessage", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const content = params?.content;
      const isSynthetic = params?.isSynthetic === true;
      if (process.env.XCODING_CLAUDE_DEBUG_MAIN === "1" || process.env.XCODING_CLAUDE_DEBUG) {
        const kind = typeof content === "string" ? "text" : Array.isArray(content) ? "blocks" : typeof content;
        const length = typeof content === "string" ? String(content).length : Array.isArray(content) ? content.length : undefined;
        console.log(`[Claude][slot ${slot}] ipc.sendUserMessage`, { kind, length, isSynthetic });
      }

      const projectRootPath = typeof params?.projectRootPath === "string" ? String(params.projectRootPath) : "";
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      const permissionMode = params?.permissionMode as ClaudePermissionMode | undefined;
      const forkSession = typeof params?.forkSession === "boolean" ? Boolean(params.forkSession) : undefined;

      if (!projectRootPath.trim()) return { ok: false, reason: "missing_projectRootPath" };
      const res = await runClaudeTurn({ slot, projectRootPath, sessionId, permissionMode, forkSession, content, isSynthetic });
      if (!res.ok) return { ok: false, reason: res.reason };
      return { ok: true, sessionId: res.sessionId ?? null, permissionMode: res.permissionMode };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_send_failed" };
    }
  });

  // Atomic "ensure started + send" to avoid renderer-side races when switching/resuming sessions.
  ipcMain.handle("claude:send", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const projectRootPath = String(params?.projectRootPath ?? "");
      if (!projectRootPath) return { ok: false, reason: "missing_projectRootPath" };
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
      const permissionMode = params?.permissionMode as ClaudePermissionMode | undefined;
      const forkSession = typeof params?.forkSession === "boolean" ? Boolean(params.forkSession) : undefined;
      const content = params?.content;
      const isSynthetic = params?.isSynthetic === true;

      if (process.env.XCODING_CLAUDE_DEBUG_MAIN === "1" || process.env.XCODING_CLAUDE_DEBUG) {
        const kind = typeof content === "string" ? "text" : Array.isArray(content) ? "blocks" : typeof content;
        const length = typeof content === "string" ? String(content).length : Array.isArray(content) ? content.length : undefined;
        console.log(`[Claude][slot ${slot}] ipc.send`, { sessionId, permissionMode, forkSession, isSynthetic, kind, length });
      }

      const res = await runClaudeTurn({ slot, projectRootPath, sessionId, permissionMode, forkSession, content, isSynthetic });
      if (!res.ok) return { ok: false, reason: res.reason };
      return { ok: true, sessionId: res.sessionId ?? null, permissionMode: res.permissionMode };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_send_failed" };
    }
  });

  ipcMain.handle("claude:interrupt", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const res = await interruptClaude(slot);
      return res.ok ? { ok: true } : { ok: false };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_interrupt_failed" };
    }
  });

  ipcMain.handle("claude:close", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const res = await closeClaude(slot);
      return res.ok ? { ok: true } : { ok: false };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_close_failed" };
    }
  });

  ipcMain.handle("claude:setPermissionMode", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const mode = String(params?.mode ?? "") as ClaudePermissionMode;
      if (mode !== "default" && mode !== "acceptEdits" && mode !== "plan" && mode !== "bypassPermissions") {
        return { ok: false, reason: "invalid_mode" };
      }
      const res = await setClaudePermissionMode({ slot, mode });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_set_mode_failed" };
    }
  });

  ipcMain.handle("claude:respondToolPermission", async (_event, params: any) => {
    try {
      const requestId = String(params?.requestId ?? "");
      const behavior = String(params?.behavior ?? "") as "allow" | "deny";
      if (!requestId) return { ok: false, reason: "missing_request_id" };
      if (behavior !== "allow" && behavior !== "deny") return { ok: false, reason: "invalid_behavior" };
      const updatedInput = params?.updatedInput;
      const updatedPermissions = params?.updatedPermissions;
      const message = typeof params?.message === "string" ? String(params.message) : undefined;
      const interrupt = params?.interrupt === true;
      const res = respondToClaudeToolPermission({ requestId, behavior, updatedInput, updatedPermissions, message, interrupt });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_permission_response_failed" };
    }
  });

  ipcMain.handle("claude:historyList", async (_event, params: any) => {
    try {
      const projectRootPath = String(params?.projectRootPath ?? "");
      const sessions = await listClaudeSessions(projectRootPath);
      return { ok: true, sessions };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_history_list_failed" };
    }
  });

  ipcMain.handle("claude:sessionRead", async (_event, params: any) => {
    try {
      const projectRootPath = String(params?.projectRootPath ?? "");
      const sessionId = String(params?.sessionId ?? "");
      if (!sessionId) return { ok: false, reason: "missing_sessionId" };
      if (!projectRootPath) return { ok: false, reason: "missing_projectRootPath" };
      const thread = await readClaudeSession({ projectRootPath, sessionId });
      return { ok: true, thread };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_session_read_failed", debug: { params } };
    }
  });

  ipcMain.handle("claude:forkSession", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      const projectRootPath = String(params?.projectRootPath ?? "");
      const baseSessionId = String(params?.sessionId ?? "");
      if (!projectRootPath || !baseSessionId) return { ok: false, reason: "missing_params" };
      await closeClaude(slot);
      const res = await ensureClaudeStarted({
        slot,
        projectRootPath,
        sessionId: baseSessionId,
        permissionMode: params?.permissionMode as ClaudePermissionMode | undefined,
        forkSession: true
      });
      if (!res.ok) return { ok: false, reason: res.reason };
      if (!res.sessionId) return { ok: false, reason: "missing_session_id" };
      return { ok: true, sessionId: res.sessionId };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_fork_failed" };
    }
  });

  ipcMain.handle("claude:turnFileDiff", async (_event, params: any) => {
    try {
      const projectRootPath = String(params?.projectRootPath ?? "");
      const sessionId = String(params?.sessionId ?? "");
      const absPath = String(params?.absPath ?? "");
      if (!projectRootPath || !sessionId || !absPath) return { ok: false, reason: "missing_params" };
      return await claudeTurnFileDiff({ projectRootPath, sessionId, absPath });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_turn_file_diff_failed" };
    }
  });

  ipcMain.handle("claude:latestSnapshotFiles", async (_event, params: any) => {
    try {
      const projectRootPath = String(params?.projectRootPath ?? "");
      const sessionId = String(params?.sessionId ?? "");
      if (!projectRootPath || !sessionId) return { ok: false, reason: "missing_params" };
      return await claudeLatestSnapshotFiles({ projectRootPath, sessionId });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_snapshot_files_failed" };
    }
  });

  ipcMain.handle("claude:revertFileFromBackup", async (_event, params: any) => {
    try {
      const absPath = String(params?.absPath ?? "");
      const content = String(params?.content ?? "");
      if (!absPath) return { ok: false, reason: "missing_absPath" };
      await fs.writeFile(absPath, content, "utf8");
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_revert_failed" };
    }
  });

  ipcMain.handle("claude:mcpServerStatus", async (_event, params: any) => {
    try {
      const slot = Number(params?.slot ?? 0);
      return await getClaudeMcpServerStatus(slot);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "claude_mcp_status_failed" };
    }
  });
}
