import type { LucideIcon } from "lucide-react";
import {
  Braces,
  Code,
  Database,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Settings,
  Terminal
} from "lucide-react";

const fileIconMap: Record<string, LucideIcon> = {
  // JavaScript/TypeScript
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  // Data/Config
  json: FileJson,
  yaml: Settings,
  yml: Settings,
  toml: Settings,
  // Web
  html: Code,
  css: Braces,
  scss: Braces,
  less: Braces,
  // Images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  // Documents
  md: FileText,
  txt: FileText,
  // Shell/Scripts
  sh: Terminal,
  bash: Terminal,
  zsh: Terminal,
  // Database
  sql: Database,
  db: Database,
  sqlite: Database,
  // Fonts
  ttf: FileType,
  otf: FileType,
  woff: FileType,
  woff2: FileType,
  // Default
  default: File
};

const specialFileIconMap: Record<string, LucideIcon> = {
  "package.json": FileJson,
  "tsconfig.json": Settings,
  ".gitignore": Settings,
  ".env": Settings,
  ".env.local": Settings,
  dockerfile: Terminal,
  "docker-compose.yml": Settings,
  "readme.md": FileText
};

export function getExplorerIcon(name: string, kind: "dir" | "file", isExpanded = false): { Icon: LucideIcon; colorClass: string } {
  if (kind === "dir") {
    return { Icon: isExpanded ? FolderOpen : Folder, colorClass: "text-[var(--xcoding-icon-folder)]" };
  }

  const lowerName = name.toLowerCase();
  const special = specialFileIconMap[lowerName];
  if (special) return { Icon: special, colorClass: "text-[var(--vscode-descriptionForeground)]" };

  const ext = name.split(".").pop()?.toLowerCase() || "";
  const Icon = fileIconMap[ext] || fileIconMap.default;

  const colorClass = (() => {
    switch (ext) {
      case "ts":
      case "tsx":
        return "text-[var(--xcoding-icon-ts)]";
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        return "text-[var(--xcoding-icon-js)]";
      case "json":
        return "text-[var(--xcoding-icon-json)]";
      case "html":
        return "text-[var(--xcoding-icon-html)]";
      case "css":
      case "scss":
      case "less":
        return "text-[var(--xcoding-icon-css)]";
      case "md":
        return "text-[var(--xcoding-icon-md)]";
      case "go":
        return "text-[var(--xcoding-icon-go)]";
      case "py":
        return "text-[var(--xcoding-icon-py)]";
      default:
        return "text-[var(--vscode-descriptionForeground)]";
    }
  })();

  return { Icon, colorClass };
}
