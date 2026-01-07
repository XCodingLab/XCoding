import { createContext, useContext } from "react";

export type UiTheme = "dark" | "light";

type UiThemeContextValue = {
  theme: UiTheme;
};

export const UiThemeContext = createContext<UiThemeContextValue>({
  theme: "dark"
});

export function useUiTheme() {
  return useContext(UiThemeContext);
}

