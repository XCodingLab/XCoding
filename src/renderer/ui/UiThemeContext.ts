import { createContext, useContext } from "react";

export type UiTheme = "dark" | "light";

type UiThemeContextValue = {
  theme: UiTheme;
  themePackId: string;
  monacoThemeName: string;
};

export const UiThemeContext = createContext<UiThemeContextValue>({
  theme: "dark",
  themePackId: "builtin-dark",
  monacoThemeName: "xcoding-dark"
});

export function useUiTheme() {
  return useContext(UiThemeContext);
}
