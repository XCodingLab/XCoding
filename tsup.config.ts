import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main/main.ts", "src/main/projectService.ts", "src/main/aiService.ts"],
  format: ["cjs"],
  target: "es2022",
  sourcemap: true,
  clean: true,
  outDir: "dist/main",
  external: ["electron", "node-pty", "@vscode/ripgrep"],
  outExtension: () => ({ js: ".cjs" })
});
