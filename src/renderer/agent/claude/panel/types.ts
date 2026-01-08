export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export type ThreadSummary = {
  id: string; // sessionId
  preview: string;
  title?: string;
  createdAt?: number;
};

export type TurnView = {
  id: string;
  status?: string;
  items: any[];
};

export type ThreadView = ThreadSummary & { turns: TurnView[] };

export type ApprovalRequest = {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: any;
  suggestions?: any;
  toolUseId?: string;
};

export type Store = {
  status: { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string };
  permissionMode: ClaudePermissionMode;
  sessionId: string | null;
  thread: ThreadView | null;
  approvals: ApprovalRequest[];
  lastStderr: string;
};

export const MODE_KEY_PREFIX = "xcoding.claude.permissionMode:";

export function modeStorageKey(projectKey: string) {
  return `${MODE_KEY_PREFIX}${projectKey}`;
}

export function safeLoadMode(projectKey: string): ClaudePermissionMode {
  try {
    const raw = localStorage.getItem(modeStorageKey(projectKey));
    if (raw === "default" || raw === "acceptEdits" || raw === "plan" || raw === "bypassPermissions") return raw;
  } catch {
    // ignore
  }
  return "default";
}

export function persistMode(projectKey: string, mode: ClaudePermissionMode) {
  try {
    localStorage.setItem(modeStorageKey(projectKey), mode);
  } catch {
    // ignore
  }
}
