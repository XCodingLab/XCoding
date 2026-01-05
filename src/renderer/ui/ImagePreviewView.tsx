import { useMemo } from "react";
import { useI18n } from "./i18n";

type Props = {
  url: string;
  title?: string;
};

function normalizeToLocalFileUrl(input: string) {
  const s = String(input ?? "");
  if (!s) return "";
  if (s.startsWith("local-file://")) return s;
  if (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("data:")) return s;
  if (s.startsWith("file://")) return `local-file://${s.slice("file://".length)}`;
  const normalized = s.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `local-file://${prefixed}`;
}

export default function ImagePreviewView({ url, title }: Props) {
  const { t } = useI18n();
  const resolved = useMemo(() => normalizeToLocalFileUrl(url), [url]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--vscode-editor-background)]">
      <div className="flex h-9 items-center gap-2 border-b border-[var(--vscode-panel-border)] px-2 text-[12px]">
        <div className="min-w-0 truncate font-semibold text-[var(--vscode-foreground)]">{title || t("image")}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {resolved ? (
          <img src={resolved} className="mx-auto max-h-full max-w-full object-contain" alt={title || t("imageAlt")} />
        ) : (
          <div className="text-sm text-[var(--vscode-descriptionForeground)]">{t("noImage")}</div>
        )}
      </div>
    </div>
  );
}
