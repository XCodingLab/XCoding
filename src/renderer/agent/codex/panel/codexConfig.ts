import type { MutableRefObject } from "react";
import type { ReasoningEffort, Store, WorkspaceWritePolicy } from "./types";

export function createCodexConfigActions({
  storeRef,
  bump,
  model,
  effort,
  setModel,
  setEffort,
  setAvailableModels,
  setConfigSnapshot
}: {
  storeRef: MutableRefObject<Store>;
  bump: () => void;
  model: string;
  effort: ReasoningEffort;
  setModel: (v: string) => void;
  setEffort: (v: ReasoningEffort) => void;
  setAvailableModels: (
    v: Array<{
      id: string;
      model: string;
      displayName: string;
      description: string;
      supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>;
      defaultReasoningEffort: ReasoningEffort;
      isDefault: boolean;
    }>
  ) => void;
  setConfigSnapshot: (v: { model?: string; effort?: ReasoningEffort; workspaceWrite?: WorkspaceWritePolicy } | null) => void;
}) {
  async function refreshConfigAndModels() {
    try {
      const [cfg, modelsRes] = await Promise.all([
        window.xcoding.codex.configRead({ includeLayers: false }),
        window.xcoding.codex.modelList({ cursor: null, limit: 200 })
      ]);

      if (cfg.ok) {
        const c = cfg.result?.config ?? {};
        const nextModel = typeof c.model === "string" ? c.model : undefined;
        const nextEffort = typeof c.model_reasoning_effort === "string" ? (c.model_reasoning_effort as ReasoningEffort) : undefined;

        const sww = c.sandbox_workspace_write;
        const workspaceWrite: WorkspaceWritePolicy = {
          writableRoots: Array.isArray(sww?.writable_roots) ? sww.writable_roots.map(String).filter(Boolean) : [],
          excludeSlashTmp: Boolean(sww?.exclude_slash_tmp),
          excludeTmpdirEnvVar: Boolean(sww?.exclude_tmpdir_env_var),
          networkAccess: Boolean(sww?.network_access)
        };

        setConfigSnapshot({ model: nextModel, effort: nextEffort, workspaceWrite });
        if (nextModel && nextModel !== model) setModel(nextModel);
        if (nextEffort && nextEffort !== effort) setEffort(nextEffort);
      }

      if (modelsRes.ok) {
        const data = Array.isArray(modelsRes.result?.data) ? (modelsRes.result.data as any[]) : [];
        const parsed = data
          .map((m) => ({
            id: String(m.id ?? ""),
            model: String(m.model ?? ""),
            displayName: String(m.displayName ?? m.display_name ?? m.model ?? ""),
            description: String(m.description ?? ""),
            supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts)
              ? m.supportedReasoningEfforts
                  .map((o: any) => ({
                    reasoningEffort: String(o.reasoningEffort ?? o.reasoning_effort ?? "") as ReasoningEffort,
                    description: String(o.description ?? "")
                  }))
                  .filter((o: any) => o.reasoningEffort)
              : [],
            defaultReasoningEffort: String(m.defaultReasoningEffort ?? m.default_reasoning_effort ?? "medium") as ReasoningEffort,
            isDefault: Boolean(m.isDefault ?? m.is_default)
          }))
          .filter((m) => m.model || m.id);

        setAvailableModels(parsed);

        const resolvedModel =
          (cfg.ok && typeof cfg.result?.config?.model === "string" ? (cfg.result.config.model as string) : "") ||
          (parsed.find((m) => m.isDefault)?.model ?? "") ||
          (parsed[0]?.model ?? "");
        if (resolvedModel && resolvedModel !== model) setModel(resolvedModel);
        const resolvedEffort =
          (cfg.ok && typeof cfg.result?.config?.modelReasoningEffort === "string"
            ? (cfg.result.config.modelReasoningEffort as ReasoningEffort)
            : undefined) ||
          (parsed.find((m) => m.model === resolvedModel)?.defaultReasoningEffort ?? "medium");
        if (resolvedEffort && resolvedEffort !== effort) setEffort(resolvedEffort);
      }

      bump();
    } catch {
      // ignore
    }
  }

  return { refreshConfigAndModels };
}

