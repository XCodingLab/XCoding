import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ReasoningEffort, WorkspaceWritePolicy } from "./types";
import { useI18n } from "../i18n";

type Props = {
  open: boolean;
  model: string;
  effort: ReasoningEffort;
  configSnapshot: { model?: string; effort?: ReasoningEffort; workspaceWrite?: WorkspaceWritePolicy } | null;
  onClose: () => void;
  onRefresh: () => void;
  extra?: ReactNode;
};

type McpServerRow = {
  name: string;
  status?: string;
  enabled?: boolean;
  error?: string;
  raw: any;
};

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseMcpServerStatusList(result: any): McpServerRow[] {
  const data = Array.isArray(result?.data) ? result.data : Array.isArray(result?.servers) ? result.servers : [];
  if (!Array.isArray(data) || data.length === 0) return [];
  return data
    .map((s: any) => {
      const name = String(s?.name ?? s?.server ?? s?.id ?? "");
      const status = typeof s?.status === "string" ? s.status : undefined;
      const enabled = typeof s?.enabled === "boolean" ? s.enabled : undefined;
      const error =
        typeof s?.error === "string"
          ? s.error
          : s?.error && typeof s.error === "object"
            ? String(s.error.message ?? "")
            : undefined;
      return { name: name || "(unknown)", status, enabled, error, raw: s } satisfies McpServerRow;
    })
    .filter((r) => r.name);
}

export default function SettingsModal({ open, model, effort, configSnapshot, onClose, onRefresh, extra }: Props) {
  if (!open) return null;

  const { t } = useI18n();

  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpRaw, setMcpRaw] = useState<any>(null);

  const mcpRows = useMemo(() => parseMcpServerStatusList(mcpRaw?.result ?? mcpRaw), [mcpRaw]);

  async function refreshMcp() {
    setMcpLoading(true);
    try {
      const res = await window.xcoding.codex.mcpServerStatusList({ cursor: null, limit: 200 });
      if (!res.ok) {
        setMcpError(res.reason ?? "mcp_list_failed");
        return;
      }
      setMcpRaw(res.result ?? null);
      setMcpError(null);
    } finally {
      setMcpLoading(false);
    }
  }

  async function setMcpEnabled(serverName: string, enabled: boolean) {
    if (!serverName) return;
    const keyPath = `mcp_servers.${serverName}.enabled`;
    const write = await window.xcoding.codex.configValueWrite({ keyPath, value: enabled, mergeStrategy: "replace" });
    if (!write.ok) {
      setMcpError(write.reason ?? "config_write_failed");
      return;
    }
    // Most MCP changes require a restart to take effect.
    const restarted = await window.xcoding.codex.restart();
    if (!restarted.ok) {
      setMcpError(restarted.reason ?? "restart_failed");
      return;
    }
    await refreshMcp();
  }

  useEffect(() => {
    if (!open) return;
    void refreshMcp();
  }, [open]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[860px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-3 py-2">
          <div className="text-[12px] font-semibold text-[var(--vscode-foreground)]">{t("settings")}</div>
          <div className="flex items-center gap-2">
            <button
              className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
              type="button"
              onClick={onRefresh}
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
            <div className="mb-2 text-[11px] font-semibold text-[var(--vscode-foreground)]">{t("configEffective")}</div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[11px]">
              {JSON.stringify(
                {
                  model,
                  model_reasoning_effort: effort,
                  sandbox_workspace_write: configSnapshot?.workspaceWrite ?? null
                },
                null,
                2
              )}
            </pre>
          </div>

          <div className="rounded border border-[var(--vscode-panel-border)] bg-black/10 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">{t("mcpServers")}</div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] disabled:opacity-50"
                  type="button"
                  disabled={mcpLoading}
                  onClick={() => void refreshMcp()}
                >
                  {t("refresh")}
                </button>
                <button
                  className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
                  type="button"
                  disabled={mcpLoading}
                  onClick={() => void window.xcoding.codex.restart().then((r) => (r.ok ? refreshMcp() : setMcpError(r.reason ?? "restart_failed")))}
                >
                  {t("restartAppServer")}
                </button>
              </div>
            </div>
            <div className="mb-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
              {t("codexMcpHint")}
            </div>
            {mcpError ? (
              <div className="mb-2 rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[11px] text-[color-mix(in_srgb,#f14c4c_90%,white)]">
                MCP error: {mcpError}
              </div>
            ) : null}
            {mcpRows.length ? (
              <div className="grid gap-2">
                {mcpRows.map((row) => (
                  <div
                    key={row.name}
                    className="rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold text-[var(--vscode-foreground)]">{row.name}</div>
                        <div className="truncate text-[11px] text-[var(--vscode-descriptionForeground)]">
                          {row.status ? `status: ${row.status}` : ""}
                          {row.enabled != null ? ` · enabled: ${String(row.enabled)}` : ""}
                        </div>
                        {row.error ? (
                          <div className="mt-1 text-[11px] text-[color-mix(in_srgb,#f14c4c_85%,white)]">error: {row.error}</div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          className="rounded bg-[var(--vscode-button-secondaryBackground)] px-2 py-1 text-[11px] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
                          type="button"
                          disabled={mcpLoading}
                          onClick={() => void setMcpEnabled(row.name, false)}
                        >
                          Disable
                        </button>
                        <button
                          className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
                          type="button"
                          disabled={mcpLoading}
                          onClick={() => void setMcpEnabled(row.name, true)}
                        >
                          Enable
                        </button>
                      </div>
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-[var(--vscode-descriptionForeground)]">{t("raw")}</summary>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[10px]">
                        {formatJson(row.raw)}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            ) : (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[11px]">
                {mcpRaw ? formatJson(mcpRaw) : mcpLoading ? "Loading…" : "No MCP data."}
              </pre>
            )}
          </div>

          {extra ?? null}
        </div>
      </div>
    </div>
  );
}
