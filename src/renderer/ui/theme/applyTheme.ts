// Theme application: apply the main-process-resolved theme pack data to CSS variables, Monaco, and global identifiers.
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
    } catch (e) {
      if (import.meta.env.DEV) console.warn("monaco.defineTheme failed", e);
    }
  }
  try {
    monaco.editor.setTheme(theme.monacoThemeName);
  } catch (e) {
    if (import.meta.env.DEV) console.warn("monaco.setTheme failed", e);
  }

  // Persist a simple background color hint to suppress startup flash before the theme pack loads.
  try {
    const bg =
      (theme.cssVars && (theme.cssVars["--aurora-base"] || theme.cssVars["--vscode-editor-background"])) ||
      (theme.monacoThemeData?.colors?.["editor.background"] as string | undefined) ||
      "";
    if (bg) localStorage.setItem("xcoding.lastThemeBg", String(bg));
    // Persist full cssVars for faster first paint on next launch.
    if (theme.cssVars) {
      const payload = { cssVars: theme.cssVars, appearance: theme.appearance };
      localStorage.setItem("xcoding.lastThemeCssVars", JSON.stringify(payload));
    }
  } catch {
    // ignore
  }
}
