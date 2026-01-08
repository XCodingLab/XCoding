// Shared types + tiny helpers extracted from CodexPanel to keep the main component readable.

export type CodexMode = "read-only" | "auto" | "full-access";

export type ThreadSummary = {
  id: string;
  preview: string;
  previewText?: string;
  title?: string;
  modelProvider?: string;
  createdAt?: number;
  path?: string;
  cwd?: string;
};

export type TurnView = {
  id: string;
  status?: string;
  items: any[];
  error?: any;
  plan?: { explanation?: string | null; steps: Array<{ step: string; status: string }> };
  diff?: string | null;
  snapshot?: { status: "available" | "applied" } | null;
};

export type ThreadView = ThreadSummary & { turns: TurnView[]; latestDiff?: string | null };

export type ApprovalRequest = { rpcId: number; method: string; params: any };

export type Store = {
  status: { state: "idle" | "starting" | "ready" | "exited" | "error"; error?: string };
  threads: ThreadSummary[];
  threadById: Record<string, ThreadView>;
  approvalsByItemId: Record<string, ApprovalRequest>;
  lastStderr: string;
  tokenUsageByThreadId: Record<string, any>;
  rateLimits: any | null;
};

export type ComposerAttachment =
  | { id: string; kind: "file"; name: string; path?: string; text: string; byteLength?: number }
  | { id: string; kind: "localImage"; name: string; path: string; source?: "picker" | "clipboard"; mime?: string; byteLength?: number };

export const MODE_KEY = "xcoding.codex.mode";
export const MODEL_KEY = "xcoding.codex.model";
export const EFFORT_KEY = "xcoding.codex.effort";
export const AUTO_CONTEXT_KEY = "xcoding.codex.autoContext";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function loadModel(): string {
  const raw = localStorage.getItem(MODEL_KEY);
  return typeof raw === "string" && raw.trim() ? raw.trim() : "gpt-5.2";
}

export function loadEffort(): ReasoningEffort {
  const raw = localStorage.getItem(EFFORT_KEY);
  if (raw === "none" || raw === "minimal" || raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") return raw;
  return "medium";
}

export function loadAutoContext(): boolean {
  const raw = localStorage.getItem(AUTO_CONTEXT_KEY);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return true;
}

export function contentKey(content: unknown) {
  try {
    return JSON.stringify(content ?? null);
  } catch {
    return String(content);
  }
}

export function loadMode(): CodexMode {
  const raw = localStorage.getItem(MODE_KEY);
  if (raw === "read-only" || raw === "auto" || raw === "full-access") return raw;

  // Backward-compat: previous versions stored chat/agent/agentFull (or plan/access/full).
  if (raw === "chat" || raw === "plan") return "read-only";
  if (raw === "agent" || raw === "access") return "auto";
  if (raw === "agentFull" || raw === "full") return "full-access";

  // Default to Agent-like behavior (auto).
  return "auto";
}

export function persistMode(mode: CodexMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}

export type WorkspaceWritePolicy = {
  writableRoots: string[];
  excludeSlashTmp: boolean;
  excludeTmpdirEnvVar: boolean;
  networkAccess: boolean;
};

export function makeTurnOverrides(mode: CodexMode, writableRoot: string | undefined, workspaceWritePolicy: WorkspaceWritePolicy | null) {
  if (mode === "full-access") return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };

  if (mode === "auto") {
    const mergedWritableRoots = [
      ...(writableRoot ? [writableRoot] : []),
      ...((workspaceWritePolicy?.writableRoots ?? []).filter(Boolean) as string[])
    ];

    return {
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: Array.from(new Set(mergedWritableRoots)),
        excludeSlashTmp: workspaceWritePolicy?.excludeSlashTmp ?? false,
        excludeTmpdirEnvVar: workspaceWritePolicy?.excludeTmpdirEnvVar ?? false,
        // Note: the upstream default is false; we follow config.toml's network_access when available.
        networkAccess: workspaceWritePolicy?.networkAccess ?? false
      }
    };
  }

  // read-only -> Chat
  return { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } };
}

export function formatThreadTime(createdAt?: number) {
  if (!createdAt || Number.isNaN(Number(createdAt))) return "";
  const ms = createdAt < 10_000_000_000 ? createdAt * 1000 : createdAt;
  const d = new Date(ms);
  return d.toLocaleString();
}

export type Props = {
  slot: number;
  projectRootPath?: string;
  onOpenUrl?: (url: string) => void;
  onOpenImage?: (absPathOrUrl: string) => void;
  isActive?: boolean;
};

export function getTabLabel(p: string) {
  const normalized = String(p ?? "").replace(/\\\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1) || normalized;
}
