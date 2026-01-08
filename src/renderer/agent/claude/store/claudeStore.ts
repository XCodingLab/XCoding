export type ClaudeUiMessage = { id: string; role: "user" | "assistant" | "system"; text: string; meta?: any };

export type ClaudeEventEnvelope =
  | { kind: "status"; slot: number; status: any }
  | { kind: "stderr"; slot: number; text: string }
  | { kind: "log"; slot: number; message: string; data?: any }
  | { kind: "stream"; slot: number; event: any };

export type ClaudeApproval = {
  at: number;
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: any;
  suggestions?: any;
  toolUseId?: string;
};

export type ClaudeStore = {
  messages: ClaudeUiMessage[];
  approvals: ClaudeApproval[];
  stderr: Array<{ at: number; text: string }>;
  logs: Array<{ at: number; message: string; data?: any }>;
  status: any;
  streaming: {
    activeAssistantMessageId: string | null;
    activeContentBlockIndex: number | null;
    activeTextBuffer: string;
  };
};

export function createClaudeStore(): ClaudeStore {
  return {
    messages: [],
    approvals: [],
    stderr: [],
    logs: [],
    status: { state: "idle" },
    streaming: { activeAssistantMessageId: null, activeContentBlockIndex: null, activeTextBuffer: "" }
  };
}

function ensureActiveAssistant(store: ClaudeStore) {
  if (store.streaming.activeAssistantMessageId) return store.streaming.activeAssistantMessageId;
  const id = `a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  store.streaming.activeAssistantMessageId = id;
  store.messages.push({ id, role: "assistant", text: "" });
  return id;
}

function appendToAssistant(store: ClaudeStore, text: string) {
  if (!text) return;
  const id = ensureActiveAssistant(store);
  const msg = store.messages.find((m) => m.id === id);
  if (!msg) return;
  msg.text += text;
}

// Best-effort parsing of Anthropic Messages stream events as emitted by the SDK.
export function applyClaudeStreamEvent(store: ClaudeStore, ev: any) {
  if (!ev || typeof ev !== "object") return;
  const outerType = String((ev as any).type ?? "");

  // The Claude Agent SDK yields SDKMessage objects (type: assistant/system/result/stream_event/...).
  // Handle those first, and fall back to raw Anthropic message stream events if present.
  if (outerType === "system") {
    const subtype = String((ev as any).subtype ?? "");
    if (subtype === "init") {
      store.messages.push({
        id: `sys-${Date.now()}`,
        role: "system",
        text: `Claude Code ${String((ev as any).claude_code_version ?? "")} (${String((ev as any).model ?? "")})`
      });
      return;
    }
    if (subtype === "status") return;
    if (subtype === "hook_response") {
      const stdout = String((ev as any).stdout ?? "");
      const stderr = String((ev as any).stderr ?? "");
      if (stdout.trim()) store.messages.push({ id: `hook-${Date.now()}`, role: "system", text: stdout });
      if (stderr.trim()) store.messages.push({ id: `hooke-${Date.now()}`, role: "system", text: stderr });
      return;
    }
    return;
  }

  if (outerType === "auth_status") {
    const lines = Array.isArray((ev as any).output) ? (ev as any).output.map((l: any) => String(l)) : [];
    if (lines.length) store.messages.push({ id: `auth-${Date.now()}`, role: "system", text: lines.join("\n") });
    return;
  }

  if (outerType === "tool_progress") {
    // Render as a lightweight system line.
    const name = String((ev as any).tool_name ?? "");
    store.messages.push({ id: `toolp-${Date.now()}`, role: "system", text: `Running tool: ${name}` });
    return;
  }

  if (outerType === "result") {
    const subtype = String((ev as any).subtype ?? "");
    if (subtype !== "success") {
      const errors = Array.isArray((ev as any).errors) ? (ev as any).errors.map((e: any) => String(e)) : [];
      if (errors.length) store.messages.push({ id: `err-${Date.now()}`, role: "system", text: errors.join("\n") });
    }
    return;
  }

  if (outerType === "assistant") {
    const msg = (ev as any).message;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const textBlocks = content.filter((b: any) => b && b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
    const toolBlocks = content.filter((b: any) => b && b.type === "tool_use");
    if (textBlocks) {
      ensureActiveAssistant(store);
      appendToAssistant(store, textBlocks);
    }
    for (const tb of toolBlocks) {
      const name = String(tb?.name ?? "tool");
      const input = tb?.input ?? {};
      store.messages.push({
        id: `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: "system",
        text: `tool_use: ${name}\n${JSON.stringify(input, null, 2)}`
      });
    }
    return;
  }

  if (outerType === "stream_event" && (ev as any).event) {
    return applyClaudeStreamEvent(store, (ev as any).event);
  }

  const type = outerType;

  if (type === "message_start") {
    store.streaming.activeAssistantMessageId = null;
    store.streaming.activeContentBlockIndex = null;
    store.streaming.activeTextBuffer = "";
    ensureActiveAssistant(store);
    return;
  }

  if (type === "content_block_start") {
    store.streaming.activeContentBlockIndex = Number((ev as any).index ?? 0);
    const block = (ev as any).content_block;
    if (block && block.type === "text" && typeof block.text === "string" && block.text) {
      appendToAssistant(store, block.text);
    }
    return;
  }

  if (type === "content_block_delta") {
    const delta = (ev as any).delta;
    if (!delta || typeof delta !== "object") return;
    const deltaType = String(delta.type ?? "");
    if (deltaType === "text_delta" && typeof delta.text === "string") {
      appendToAssistant(store, delta.text);
      return;
    }
    // Ignore tool input streaming JSON; we'll render tool_use blocks from the final assistant message instead.
    return;
  }

  if (type === "message_stop") {
    store.streaming.activeAssistantMessageId = null;
    store.streaming.activeContentBlockIndex = null;
    store.streaming.activeTextBuffer = "";
    return;
  }
}
