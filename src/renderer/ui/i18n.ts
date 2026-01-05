import { createContext, useContext } from "react";
import { enUS } from "./i18n/en-US";
import { zhCN } from "./i18n/zh-CN";

export type Language = "en-US" | "zh-CN";

export const messages = {
  "en-US": enUS,
  "zh-CN": zhCN
} as const;

export type I18nKey = keyof typeof enUS;

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: I18nKey) => string;
};

export const I18nContext = createContext<I18nContextValue>({
  language: "en-US",
  setLanguage: () => {},
  t: (key) => messages["en-US"][key]
});

export function useI18n() {
  return useContext(I18nContext);
}

