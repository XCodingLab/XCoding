import React from "react";
import ReactDOM from "react-dom/client";
import "./monacoSetup";
import App from "./ui/App";
import "./styles.css";

function isElectronRuntime(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return ua.includes("Electron");
}

function isXcodingBridgeAvailable(): boolean {
  return typeof window !== "undefined" && typeof (window as any).xcoding === "object" && (window as any).xcoding !== null;
}

function MissingBridgeScreen() {
  const isElectron = isElectronRuntime();
  const title = isElectron ? "XCoding preload bridge missing" : "XCoding needs the Electron bridge";
  const detail = isElectron
    ? "This window was opened without the preload bridge (window.xcoding). Make sure you started the app via `pnpm run dev` (Electron), not just Vite."
    : "You opened the renderer in a regular browser, but this build expects the Electron preload bridge (window.xcoding).";
  const devServerUrl = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:5173";

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-8">
      <div className="max-w-xl w-full rounded-lg border border-neutral-800 bg-neutral-900/30 p-6 space-y-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-neutral-300">{detail}</p>
        <div className="rounded-md bg-neutral-950/40 border border-neutral-800 p-3 text-sm font-mono whitespace-pre-wrap">
          {isElectron ? "pnpm run dev" : "pnpm run dev  # launches Electron with preload"}
        </div>
        <p className="text-xs text-neutral-500">
          Tip: if HMR WebSocket fails on localhost, try opening the dev server via{" "}
          <span className="font-mono">{devServerUrl}</span>.
        </p>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

const root = ReactDOM.createRoot(rootEl);
root.render(isXcodingBridgeAvailable() ? <App /> : <MissingBridgeScreen />);
