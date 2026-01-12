import DiffViewer from "./DiffViewer";

export type ProposedDiffCardPreview =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "diff"; relPath: string; unifiedDiff: string; added?: number; removed?: number; atMs?: number };

function formatCounts(added?: number, removed?: number) {
  const a = typeof added === "number" && Number.isFinite(added) && added > 0 ? `+${added}` : "";
  const r = typeof removed === "number" && Number.isFinite(removed) && removed > 0 ? `-${removed}` : "";
  return [a, r].filter(Boolean).join(" ");
}

export default function ProposedDiffCard({ preview }: { preview: ProposedDiffCardPreview }) {
  if (!preview) return null;
  if (preview.kind === "loading") {
    return (
      <div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
        Proposed diff: generating…
      </div>
    );
  }
  if (preview.kind === "error") {
    return (
      <div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-2 text-[11px] text-[color-mix(in_srgb,#f14c4c_85%,white)]">
        Proposed diff unavailable: {preview.error}
      </div>
    );
  }

  const counts = formatCounts(preview.added, preview.removed);
  const title = preview.relPath || "Proposed diff";
  return (
    <div className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-2 py-1">
        <div className="min-w-0 truncate text-[11px] font-semibold text-[var(--vscode-foreground)]">{title}</div>
        {counts ? <div className="shrink-0 text-[11px] text-[var(--vscode-descriptionForeground)]">{counts}</div> : null}
      </div>
      <div className="p-1">
        <DiffViewer diff={String(preview.unifiedDiff ?? "")} showFileList={false} showMetaLines={false} />
      </div>
    </div>
  );
}
