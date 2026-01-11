import type { ReactNode } from "react";

export type ClaudeCommandAction = {
  id: string;
  label: string;
  description?: string;
  filterOnly?: boolean;
  keepMenuOpen?: boolean;
  trailingComponent?: ReactNode;
};

export type ClaudeCommandRunContext = {
  viaTab: boolean;
};

export type ClaudeRegisteredCommand = ClaudeCommandAction & {
  section: string;
  run: (ctx: ClaudeCommandRunContext) => void;
};

export class ClaudeCommandRegistry {
  private byId = new Map<string, ClaudeRegisteredCommand>();
  private sectionOrder: string[] = [];
  private orderInSection = new Map<string, string[]>();

  registerAction(action: ClaudeCommandAction, section: string, run: (ctx: ClaudeCommandRunContext) => void) {
    const id = String(action.id ?? "").trim();
    const sec = String(section ?? "").trim();
    if (!id) throw new Error("command.id is required");
    if (!sec) throw new Error("command.section is required");

    const next: ClaudeRegisteredCommand = {
      id,
      label: String(action.label ?? ""),
      description: typeof action.description === "string" ? action.description : undefined,
      filterOnly: Boolean(action.filterOnly),
      keepMenuOpen: Boolean(action.keepMenuOpen),
      trailingComponent: action.trailingComponent,
      section: sec,
      run
    };

    const existing = this.byId.get(id) ?? null;
    this.byId.set(id, next);

    if (!this.sectionOrder.includes(sec)) this.sectionOrder.push(sec);

    const ids = this.orderInSection.get(sec) ?? [];
    if (!ids.includes(id)) this.orderInSection.set(sec, [...ids, id]);

    if (existing && existing.section !== sec) {
      const prev = this.orderInSection.get(existing.section) ?? [];
      this.orderInSection.set(
        existing.section,
        prev.filter((x) => x !== id)
      );
    }
  }

  unregisterByPrefix(prefix: string) {
    const p = String(prefix ?? "");
    if (!p) return;
    for (const id of Array.from(this.byId.keys())) {
      if (!id.startsWith(p)) continue;
      const prev = this.byId.get(id);
      this.byId.delete(id);
      if (!prev) continue;
      const list = this.orderInSection.get(prev.section) ?? [];
      this.orderInSection.set(
        prev.section,
        list.filter((x) => x !== id)
      );
    }
  }

  getCommandsBySection(includeFilterOnly: boolean): Record<string, ClaudeRegisteredCommand[]> {
    const out: Record<string, ClaudeRegisteredCommand[]> = {};
    for (const section of this.sectionOrder) {
      const ids = this.orderInSection.get(section) ?? [];
      const list: ClaudeRegisteredCommand[] = [];
      for (const id of ids) {
        const cmd = this.byId.get(id);
        if (!cmd) continue;
        if (cmd.filterOnly && !includeFilterOnly) continue;
        list.push(cmd);
      }
      if (list.length) out[section] = list;
    }
    return out;
  }

  getById(id: string) {
    return this.byId.get(id) ?? null;
  }
}

