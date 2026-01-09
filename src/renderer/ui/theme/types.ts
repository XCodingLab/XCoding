// Renderer theme types: kept in sync with the main-process `themes` IPC payloads.
export type ThemeAppearance = "dark" | "light";

export type ThemePackSummary = {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  source: "builtin" | "user";
};

export type MonacoThemeData = {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
  colors: Record<string, string>;
};

export type ResolvedThemePack = {
  id: string;
  name: string;
  appearance: ThemeAppearance;
  cssVars: Record<string, string>;
  monacoThemeName: string;
  monacoThemeData?: MonacoThemeData;
  extraCssText?: string;
};
