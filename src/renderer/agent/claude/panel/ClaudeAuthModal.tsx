import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type ClaudeAuthStatus = {
  isAuthenticating: boolean;
  output: string[];
  error?: string | null;
};

type Props = {
  open: boolean;
  status: ClaudeAuthStatus | null;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  onSubmitCode: (code: string) => void;
  onOpenInTerminal: () => void;
};

function extractFirstUrl(lines: string[]) {
  for (const line of lines) {
    const m = String(line ?? "").match(/\bhttps?:\/\/[^\s)]+/i);
    if (m?.[0]) return m[0];
  }
  return null;
}

export default function ClaudeAuthModal({ open, status, onClose, onOpenUrl, onSubmitCode, onOpenInTerminal }: Props) {
  const [code, setCode] = useState("");
  const url = useMemo(() => extractFirstUrl(status?.output ?? []), [status?.output]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    setCode("");
  }, [open]);

  if (!open) return null;

  const title = status?.isAuthenticating ? "Authenticating…" : "Login";
  const error = status?.error ? String(status.error) : "";
  const output = (status?.output ?? []).map((l) => String(l ?? "")).join("\n").trim();

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[760px] overflow-hidden rounded-xl border border-[var(--vscode-panel-border)] bg-[var(--modal-background)] shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--vscode-panel-border)] px-3 py-2">
          <div className="text-[12px] font-semibold text-[var(--vscode-foreground)]">{title}</div>
          <div className="flex items-center gap-2">
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
          {error ? (
            <div className="rounded border border-[var(--vscode-panel-border)] bg-black/20 p-2 text-[11px] text-[var(--vscode-errorForeground)]">
              {error}
            </div>
          ) : null}

          <div className="rounded border border-[var(--vscode-panel-border)] bg-black/10 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-[var(--vscode-foreground)]">Output</div>
              <div className="flex items-center gap-2">
                {url ? (
                  <button
                    className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                    type="button"
                    onClick={() => onOpenUrl(url)}
                    title={url}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open link
                  </button>
                ) : null}
                <button
                  className="rounded px-2 py-1 text-[11px] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                  type="button"
                  onClick={onOpenInTerminal}
                >
                  Open in Terminal
                </button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap break-words rounded bg-black/20 p-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
              {output || (status?.isAuthenticating ? "Waiting for auth output…" : "No output.")}
            </pre>
          </div>

          <div className="rounded border border-[var(--vscode-panel-border)] bg-black/10 p-3">
            <div className="mb-2 text-[11px] font-semibold text-[var(--vscode-foreground)]">OAuth / Device code</div>
            <div className="flex items-center gap-2">
              <input
                className="w-full rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-input-background)] px-2 py-1 text-[12px] text-[var(--vscode-input-foreground)] outline-none"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste code here…"
              />
              <button
                className="rounded bg-[var(--vscode-button-background)] px-2 py-1 text-[11px] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50"
                type="button"
                disabled={!code.trim()}
                onClick={() => onSubmitCode(code)}
              >
                Submit
              </button>
            </div>
            <div className="mt-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
              Submitting code is sent as a synthetic message and won’t appear in the transcript.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

