export const PROMPT_REQUEST_BEGIN = "## My request for Codex:";

export type IdeContext = {
  activeFile?: {
    label?: string;
    path?: string;
    selection?: unknown;
    selections?: unknown;
    activeSelectionContent?: string;
  };
  openTabs?: Array<{ label: string; path: string }>;
};

export function extractPromptRequest(message: string) {
  const parts = String(message ?? "").split(PROMPT_REQUEST_BEGIN);
  if (parts.length <= 1) return String(message ?? "");
  return (parts[parts.length - 1] ?? "").trim();
}

export function buildPromptContextSection({ ideContext }: { ideContext?: IdeContext | null }) {
  const ctx = ideContext ?? null;
  const activePath = typeof ctx?.activeFile?.path === "string" ? ctx.activeFile.path : "";
  const activeLabel = typeof ctx?.activeFile?.label === "string" ? ctx.activeFile.label : "";
  const selectionContent = typeof ctx?.activeFile?.activeSelectionContent === "string" ? ctx.activeFile.activeSelectionContent : "";
  const openTabs = Array.isArray(ctx?.openTabs) ? ctx.openTabs : [];
  const hasTabs = openTabs.some((t) => t && typeof t === "object" && typeof (t as any).path === "string" && String((t as any).path).trim());

  // If there is no IDE context at all, don't inject a section.
  if (!activePath && !selectionContent && !hasTabs) return "";

  const lines: string[] = [];
  lines.push("# Context from my IDE setup:");
  lines.push("");
  if (!activePath && !hasTabs) {
    lines.push("## Open files:");
    lines.push("No files are currently open in the editor.");
  } else {
    lines.push("## Open files:");
    if (!hasTabs) {
      lines.push("(No tabs information available.)");
    } else {
      for (const tab of openTabs) {
        if (!tab || typeof tab !== "object") continue;
        const label = typeof (tab as any).label === "string" ? String((tab as any).label) : "";
        const path = typeof (tab as any).path === "string" ? String((tab as any).path) : "";
        if (!path.trim()) continue;
        lines.push(`- ${label || path}: ${path}`);
      }
    }
  }

  lines.push("");
  lines.push("## Focused file:");
  lines.push(activePath ? `${activeLabel ? `${activeLabel}: ` : ""}${activePath}` : "No focused file.");

  if (selectionContent) {
    lines.push("");
    lines.push("## Selected text in the focused file:");
    lines.push(selectionContent);
  }

  return lines.join("\n");
}

export function renderComposerPrompt({ requestMessage, ideContext }: { requestMessage: string; ideContext?: IdeContext | null }) {
  const context = buildPromptContextSection({ ideContext });
  if (!context) return requestMessage;
  return `${context}\n\n${PROMPT_REQUEST_BEGIN}\n${requestMessage}`;
}
