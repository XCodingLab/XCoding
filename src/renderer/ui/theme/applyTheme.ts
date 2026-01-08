// 主题应用：将主进程解析后的主题包数据应用到 CSS Variables、Monaco 与全局标识上。
import { monaco } from "../../monacoSetup";
import type { ResolvedThemePack } from "./types";

let appliedVarKeys: string[] = [];
let extraCssEl: HTMLStyleElement | null = null;

export function applyResolvedThemePack(theme: ResolvedThemePack) {
  const root = document.documentElement;
  root.dataset.theme = theme.appearance;
  root.dataset.themePack = theme.id;
  root.style.colorScheme = theme.appearance;

  for (const key of appliedVarKeys) {
    root.style.removeProperty(key);
  }

  const nextKeys: string[] = [];
  for (const [key, value] of Object.entries(theme.cssVars || {})) {
    if (!key.startsWith("--")) continue;
    nextKeys.push(key);
    root.style.setProperty(key, String(value));
  }
  appliedVarKeys = nextKeys;

  if (!extraCssEl) {
    extraCssEl = document.createElement("style");
    extraCssEl.id = "xcoding-theme-pack-css";
    document.head.appendChild(extraCssEl);
  }
  extraCssEl.textContent = theme.extraCssText || "";

  if (theme.monacoThemeData) {
    try {
      monaco.editor.defineTheme(theme.monacoThemeName, theme.monacoThemeData as any);
    } catch {
      // ignore
    }
  }
  try {
    monaco.editor.setTheme(theme.monacoThemeName);
  } catch {
    // ignore
  }
}

