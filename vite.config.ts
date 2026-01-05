import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import monacoPluginImport from "vite-plugin-monaco-editor";

const monacoEditorPlugin = (monacoPluginImport as any).default ?? monacoPluginImport;

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    monacoEditorPlugin({
      languageWorkers: ["editorWorkerService", "typescript", "json", "html", "css"]
    })
  ],
  optimizeDeps: {
    // Prevent Vite from scanning the huge `reference/` tree (e.g. vendored VS Code sources)
    // which contains many *.html entries and will break dependency scanning.
    entries: ["index.html"]
  },
  build: {
    rollupOptions: {
      input: {
        app: "index.html"
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
