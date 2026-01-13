import type * as monaco from "monaco-editor";
import type { MonacoLanguageId } from "../../languageSupport";

export type WorkingCopySnapshot = {
  slot: number;
  relPath: string;
  uri: monaco.Uri;
  languageId: MonacoLanguageId;

  isResolved: boolean;
  isLoading: boolean;
  error: string | null;

  dirty: boolean;
  conflict: boolean;
  orphaned: boolean;

  isBinary: boolean;
  truncated: boolean;
  size: number;
  mtimeMs: number;
};

export type WorkingCopyListener = (snapshot: WorkingCopySnapshot) => void;

