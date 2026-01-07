import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  applyCodexTurnSnapshot,
  ensureCodexBridge,
  getCodexStatusSnapshot,
  readCodexTurnFileDiff,
  respondToCodex,
  restartCodexBridge,
  revertCodexTurnSnapshot,
  tryFetchCustomModelList
} from "../managers/codexManager";

export function registerCodexIpc() {
  ipcMain.handle("codex:ensureStarted", async () => {
    try {
      await ensureCodexBridge().ensureStarted();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_start_failed" };
    }
  });

  ipcMain.handle("codex:getStatus", async () => {
    try {
      return { ok: true, ...getCodexStatusSnapshot() };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_status_failed" };
    }
  });

  ipcMain.handle("codex:threadList", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_list_failed" };
    }
  });

  ipcMain.handle("codex:threadStart", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/start", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_start_failed" };
    }
  });

  ipcMain.handle("codex:threadResume", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/resume", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_resume_failed" };
    }
  });

  ipcMain.handle("codex:sessionRead", async (_event, params: any) => {
    try {
      const filePath = String(params?.path ?? "");
      if (!filePath) return { ok: false, reason: "missing_path" };
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) return { ok: false, reason: "not_found" };
      const raw = fs.readFileSync(resolved, "utf8");

      const turns: any[] = [];
      let current: any | null = null;
      const toolByCallId = new Map<string, any>();

      const ensureTurn = () => {
        if (!current) {
          current = { id: `turn-${turns.length + 1}`, items: [], status: "completed", error: null };
          turns.push(current);
        }
        return current;
      };

      const pushUser = (text: string) => {
        current = { id: `turn-${turns.length + 1}`, items: [], status: "completed", error: null };
        turns.push(current);
        current.items.push({ type: "userMessage", id: `item-user-${current.id}`, content: [{ type: "text", text }] });
      };

      const pushReasoning = (text: string) => {
        const t = ensureTurn();
        t.items.push({ type: "reasoning", id: `item-reasoning-${t.id}-${t.items.length + 1}`, summary: [String(text ?? "")], content: [] });
      };

      const pushAgent = (text: string) => {
        const t = ensureTurn();
        t.items.push({ type: "agentMessage", id: `item-agent-${t.id}-${t.items.length + 1}`, text: String(text ?? "") });
      };

      const upsertTool = (callId: string, patch: (item: any) => void) => {
        const t = ensureTurn();
        let item = toolByCallId.get(callId);
        if (!item) {
          item = { type: "localToolCall", id: callId, name: "", arguments: "", input: "", output: "", status: "completed" };
          toolByCallId.set(callId, item);
          t.items.push(item);
        }
        patch(item);
      };

      const normalizeRolloutLineType = (value: unknown) => {
        const raw = typeof value === "string" ? value.trim() : "";
        if (!raw) return "";
        if (raw === "eventMsg") return "event_msg";
        if (raw === "responseItem") return "response_item";
        if (raw === "sessionMeta") return "session_meta";
        if (raw === "turnContext") return "turn_context";
        return raw;
      };

      const unwrapRolloutLine = (obj: any): { type: string; payload: any } => {
        if (!obj || typeof obj !== "object") return { type: "", payload: null };
        if (typeof obj.type === "string") return { type: obj.type, payload: obj.payload ?? null };
        const nested = (obj as any).item;
        if (nested && typeof nested === "object" && typeof nested.type === "string") return { type: nested.type, payload: (nested as any).payload ?? null };
        return { type: "", payload: null };
      };

      const normalizeEventMsgType = (value: unknown) => {
        const raw = typeof value === "string" ? value.trim() : "";
        if (!raw) return "";
        if (raw === "userMessage") return "user_message";
        if (raw === "agentMessage") return "agent_message";
        if (raw === "agentReasoning") return "agent_reasoning";
        if (raw === "agentReasoningRawContent") return "agent_reasoning_raw_content";
        return raw;
      };

      const normalizeResponseItemType = (value: unknown) => {
        const raw = typeof value === "string" ? value.trim() : "";
        if (!raw) return "";
        if (raw === "functionCall") return "function_call";
        if (raw === "functionCallOutput") return "function_call_output";
        if (raw === "customToolCall") return "custom_tool_call";
        if (raw === "customToolCallOutput") return "custom_tool_call_output";
        if (raw === "localShellCall") return "local_shell_call";
        return raw;
      };

      const stringifyToolOutput = (value: any) => {
        if (typeof value === "string") return value;
        if (value == null) return "";
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      };

      const normalizeToolItemType = (item: any) => {
        const name = String(item?.name ?? "");
        if (name === "shell_command") {
          item.type = "commandExecution";
          try {
            const args = JSON.parse(String(item.arguments ?? "{}"));
            if (args && typeof args === "object" && typeof args.command === "string") item.command = args.command;
          } catch {
            // ignore
          }
          if (typeof item.output === "string") item.aggregatedOutput = item.output;
        } else if (name === "apply_patch") {
          item.type = "fileChange";
          const patchText = String(item.input ?? "");
          if (patchText) {
            const changes: Array<{ path: string; kind: string; diff: string }> = [];
            const lines = patchText.split(/\r?\n/);
            let currentFile: { path: string; kind: string; lines: string[] } | null = null;

            const flush = () => {
              if (!currentFile) return;
              const diff = currentFile.lines.join("\n").trim();
              if (diff) changes.push({ path: currentFile.path, kind: currentFile.kind, diff });
              currentFile = null;
            };

            for (const line of lines) {
              const m = line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
              if (m && m[2]) {
                flush();
                const kind = m[1] === "Add File" ? "add" : m[1] === "Delete File" ? "delete" : "update";
                currentFile = { path: m[2].trim(), kind, lines: [] };
                continue;
              }
              if (!currentFile) continue;
              currentFile.lines.push(line);
            }
            flush();
            (item as any).changes = changes.length ? changes : [{ path: "patch", kind: "patch", diff: patchText }];
          }
        }
      };

      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const { type: rawType, payload } = unwrapRolloutLine(obj);
        const type = normalizeRolloutLineType(rawType);

        if (type === "event_msg" && payload && typeof payload === "object") {
          const msgType = normalizeEventMsgType(payload.type);
          if (msgType === "user_message") pushUser(String(payload.text ?? ""));
          else if (msgType === "agent_message") pushAgent(String(payload.text ?? ""));
          else if (msgType === "agent_reasoning" || msgType === "agent_reasoning_raw_content") pushReasoning(String(payload.text ?? ""));
          continue;
        }

        if (type === "response_item" && payload && typeof payload === "object") {
          const pType = normalizeResponseItemType(payload.type);
          if (pType === "function_call") {
            const callId = String(payload.call_id ?? payload.callId ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.name = String(payload.name ?? it.name ?? "");
              it.arguments = String(payload.arguments ?? it.arguments ?? "");
              it.status = "completed";
              normalizeToolItemType(it);
            });
          } else if (pType === "function_call_output") {
            const callId = String(payload.call_id ?? payload.callId ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.output = stringifyToolOutput(payload.output ?? it.output ?? "");
              it.status = "completed";
              normalizeToolItemType(it);
            });
          } else if (pType === "custom_tool_call") {
            const callId = String(payload.call_id ?? payload.callId ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.name = String(payload.name ?? it.name ?? "");
              it.input = String(payload.input ?? it.input ?? "");
              it.status = String(payload.status ?? it.status ?? "completed");
              normalizeToolItemType(it);
            });
          } else if (pType === "custom_tool_call_output") {
            const callId = String(payload.call_id ?? payload.callId ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.output = stringifyToolOutput(payload.output ?? it.output ?? "");
              it.status = "completed";
              normalizeToolItemType(it);
            });
          } else if (pType === "local_shell_call") {
            const callId = String(payload.call_id ?? payload.callId ?? "");
            if (!callId) continue;
            upsertTool(callId, (it) => {
              it.type = "commandExecution";
              it.status = String(payload.status ?? it.status ?? "completed");
              const action = payload.action;
              if (action && typeof action === "object") {
                const cmd = Array.isArray(action.command)
                  ? action.command.map((part: any) => String(part ?? "")).filter(Boolean).join(" ")
                  : typeof action.command === "string"
                    ? action.command
                    : "";
                if (cmd) it.command = cmd;
                const cwd =
                  typeof action.working_directory === "string"
                    ? action.working_directory
                    : typeof action.workingDirectory === "string"
                      ? action.workingDirectory
                      : "";
                if (cwd) it.cwd = cwd;
              }
              normalizeToolItemType(it);
            });
          } else if (pType === "reasoning") {
            const content = Array.isArray(payload.content) ? payload.content : [];
            const txtContent = content.map((c: any) => (c && typeof c === "object" ? String(c.text ?? "") : "")).join("");
            const summary = Array.isArray(payload.summary) ? payload.summary : [];
            const txtSummary = summary.map((c: any) => (c && typeof c === "object" ? String(c.text ?? "") : "")).join("");
            const txt = txtContent || txtSummary;
            if (txt) pushReasoning(txt);
          }
          continue;
        }
      }

      return { ok: true, result: { turns } };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "session_read_failed" };
    }
  });

  ipcMain.handle("codex:writeImageAttachment", async (_event, params: any) => {
    try {
      const mime = typeof params?.mime === "string" && params.mime.startsWith("image/") ? params.mime : "image/png";
      const bytes = params?.bytes;
      if (!(bytes instanceof ArrayBuffer)) return { ok: false, reason: "missing_bytes" };
      const buf = Buffer.from(new Uint8Array(bytes));
      if (!buf.length) return { ok: false, reason: "empty_bytes" };

      const dir = path.join(app.getPath("userData"), "codex-attachments");
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // ignore
      }

      // Best-effort cleanup: delete files older than 30 days.
      try {
        const entries = fs.readdirSync(dir);
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const name of entries) {
          const full = path.join(dir, name);
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            if (st.mtimeMs < cutoff) fs.unlinkSync(full);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }

      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
      const suggested = typeof params?.suggestedName === "string" ? params.suggestedName : "";
      const baseName = suggested.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
      const safeStem = baseName ? baseName.replace(/\.[a-zA-Z0-9]+$/, "") : "clipboard";
      const fileName = `${safeStem}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, buf);

      return { ok: true, result: { path: filePath, byteLength: buf.length, mime } };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "write_image_attachment_failed" };
    }
  });

  ipcMain.handle("codex:readLocalImageAsDataUrl", async (_event, params: any) => {
    try {
      const filePath = typeof params?.path === "string" ? params.path : "";
      if (!filePath) return { ok: false, reason: "missing_path" };

      const MAX_BYTES = 10 * 1024 * 1024;
      const st = fs.statSync(filePath);
      if (!st.isFile()) return { ok: false, reason: "not_a_file" };
      if (st.size <= 0) return { ok: false, reason: "empty_file" };
      if (st.size > MAX_BYTES) return { ok: false, reason: "file_too_large" };

      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".bmp"
                ? "image/bmp"
                : ext === ".svg"
                  ? "image/svg+xml"
                  : "image/png";

      const buf = fs.readFileSync(filePath);
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      return { ok: true, result: { dataUrl, mime, byteLength: buf.length } };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "read_local_image_failed" };
    }
  });

  ipcMain.handle("codex:threadArchive", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("thread/archive", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_thread_archive_failed" };
    }
  });

  ipcMain.handle("codex:turnStart", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("turn/start", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_turn_start_failed" };
    }
  });

  ipcMain.handle("codex:turnInterrupt", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("turn/interrupt", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_turn_interrupt_failed" };
    }
  });

  ipcMain.handle("codex:reviewStart", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("review/start", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_review_start_failed" };
    }
  });

  ipcMain.handle("codex:modelList", async (_event, params: any) => {
    try {
      const custom = await tryFetchCustomModelList();
      if (custom) return { ok: true, result: custom };
      const result = await ensureCodexBridge().request("model/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_model_list_failed" };
    }
  });

  ipcMain.handle("codex:skillsList", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("skills/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_skills_list_failed" };
    }
  });

  ipcMain.handle("codex:mcpServerStatusList", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("mcpServerStatus/list", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_mcp_server_status_list_failed" };
    }
  });

  ipcMain.handle("codex:configRead", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("config/read", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_config_read_failed" };
    }
  });

  ipcMain.handle("codex:configValueWrite", async (_event, params: any) => {
    try {
      const result = await ensureCodexBridge().request("config/value/write", params ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_config_write_failed" };
    }
  });

  ipcMain.handle("codex:restart", async () => {
    try {
      await restartCodexBridge();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_restart_failed" };
    }
  });

  ipcMain.handle("codex:turnRevert", async (_event, { threadId, turnId }: { threadId: string; turnId: string }) => {
    if (!threadId || !turnId) return { ok: false, reason: "missing_ids" };
    return revertCodexTurnSnapshot(String(threadId), String(turnId));
  });

  ipcMain.handle("codex:turnApply", async (_event, { threadId, turnId }: { threadId: string; turnId: string }) => {
    if (!threadId || !turnId) return { ok: false, reason: "missing_ids" };
    return applyCodexTurnSnapshot(String(threadId), String(turnId));
  });

  ipcMain.handle("codex:turnFileDiff", async (_event, params: any) => {
    try {
      const threadId = String(params?.threadId ?? "");
      const turnId = String(params?.turnId ?? "");
      const relPath = String(params?.path ?? params?.relPath ?? "");
      const maxBytes = typeof params?.maxBytes === "number" ? params.maxBytes : undefined;
      const res = readCodexTurnFileDiff({ threadId, turnId, relPath, maxBytes });
      return res;
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_turn_file_diff_failed" };
    }
  });

  ipcMain.handle("codex:respond", async (_event, { id, result, error }: { id: number; result?: any; error?: any }) => {
    try {
      respondToCodex({ id, result, error });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "codex_respond_failed" };
    }
  });
}
