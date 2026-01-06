export type DiffLineKind = "add" | "remove" | "hunk" | "file" | "meta" | "patch" | "comment";

export function classifyDiffLine(rawLine: string): DiffLineKind | null {
  const line = String(rawLine ?? "");
  if (!line) return null;

  if (line.startsWith("*** ")) return "patch";
  if (line.startsWith("\\ No newline at end of file")) return "comment";

  if (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("GIT binary patch") ||
    line.startsWith("literal ") ||
    line.startsWith("delta ")
  ) {
    return "meta";
  }

  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "file";
  if (line.startsWith("@@")) return "hunk";

  if (line.startsWith("+") && !line.startsWith("+++ ")) return "add";
  if (line.startsWith("-") && !line.startsWith("--- ")) return "remove";

  return null;
}

