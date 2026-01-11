import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../ui/i18n";

type Props = {
  open: boolean;
  slot: number;
  projectRootPath?: string;
  permissionMode: string;
  onClose: () => void;
};

export default function ClaudeSettingsModal({ open, slot, projectRootPath, permissionMode, onClose }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<Array<{ name: string; status: string }>>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.xcoding.claude.mcpServerStatus({ slot });
      if (!res?.ok) {
        setError(String(res?.reason ?? "mcp_status_failed"));
        setServers([]);
        return;
      }
      const rows = Array.isArray(res.servers) ? res.servers : [];
      setServers(rows.map((s: any) => ({ name: String(s?.name ?? ""), status: String(s?.status ?? "") })).filter((s) => s.name));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [slot]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Align with other overlays: Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[720px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-3 py-2">
          <div className="text-[12px] font-semibold text-[var(--vscode-foreground)]">{t("settings")}</div>
          <div className="flex items-center gap-2">
            <button
              className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
              type="button"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {t("refresh")}
            </button>
            <button
              className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              type="button"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="grid max-h-[70vh] gap-3 overflow-auto p-3 text-[12px] text-[var(--vscode-foreground)]">
          <div className="rounded border border-[var(--vscode-panel-border)] bg-black/10 p-3">
            <div className="mb-2 text-[11px] font-semibold text-[var(--vscode-foreground)]">Claude</div>
            <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">slot: {slot}</div>
            <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">mode: {permissionMode}</div>
            {projectRootPath ? (
              <div className="mt-1 truncate text-[11px] text-[var(--vscode-descriptionForeground)]" title={projectRootPath}>
                project: {projectRootPath}
              </div>
            ) : null}
          </div>

          <div className="rounded border border-[var(--vscode-panel-border)] bg-black/10 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">{t("mcpServers")}</div>
              <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{loading ? `${t("loading")}…` : ""}</div>
            </div>
            {error ? (
              <div className="mb-2 rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[11px] text-[color-mix(in_srgb,#f14c4c_90%,white)]">
                MCP error: {error}
              </div>
            ) : null}
            {servers.length ? (
              <div className="flex flex-wrap gap-2">
                {servers.map((s) => (
                  <span
                    key={s.name}
                    className="rounded bg-[var(--vscode-badge-background)] px-2 py-0.5 text-[10px] text-[var(--vscode-badge-foreground)]"
                    title={s.status}
                  >
                    {s.name}:{s.status}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-[var(--vscode-descriptionForeground)]">{loading ? "" : "No MCP servers."}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
