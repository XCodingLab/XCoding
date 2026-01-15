import { useLayoutEffect, useRef } from "react";
import type { ComposerAttachment } from "./types";

export function useCodexProjectScopedState({
  projectKey,
  isHistoryOpen,
  activeThreadId,
  query,
  input,
  attachments,
  isPlusMenuOpen,
  isSlashMenuOpen,
  setIsHistoryOpen,
  setActiveThreadId,
  setQuery,
  setInput,
  setAttachments,
  setIsPlusMenuOpen,
  setIsSlashMenuOpen,
  setLoadingThreadId,
  bump,
  bumpThreads
}: {
  projectKey: string;
  isHistoryOpen: boolean;
  activeThreadId: string | null;
  query: string;
  input: string;
  attachments: ComposerAttachment[];
  isPlusMenuOpen: boolean;
  isSlashMenuOpen: boolean;
  setIsHistoryOpen: (v: boolean) => void;
  setActiveThreadId: (v: string | null) => void;
  setQuery: (v: string) => void;
  setInput: (v: string) => void;
  setAttachments: (v: ComposerAttachment[]) => void;
  setIsPlusMenuOpen: (v: boolean) => void;
  setIsSlashMenuOpen: (v: boolean) => void;
  setLoadingThreadId: (v: string | null) => void;
  bump: () => void;
  bumpThreads: () => void;
}) {
  const projectStateRef = useRef(
    new Map<
      string,
      {
        isHistoryOpen: boolean;
        activeThreadId: string | null;
        query: string;
        input: string;
        attachments: ComposerAttachment[];
        isPlusMenuOpen: boolean;
        isSlashMenuOpen: boolean;
      }
    >()
  );

  const lastProjectKeyRef = useRef<string>(projectKey);
  useLayoutEffect(() => {
    const prevKey = lastProjectKeyRef.current;
    const nextKey = projectKey;
    if (prevKey === nextKey) return;

    projectStateRef.current.set(prevKey, {
      isHistoryOpen,
      activeThreadId,
      query,
      input,
      attachments,
      isPlusMenuOpen,
      isSlashMenuOpen
    });

    const restored =
      projectStateRef.current.get(nextKey) ??
      ({
        isHistoryOpen: true,
        activeThreadId: null,
        query: "",
        input: "",
        attachments: [],
        isPlusMenuOpen: false,
        isSlashMenuOpen: false
      } as const);

    setIsHistoryOpen((restored as any).isHistoryOpen ?? true);
    setActiveThreadId(restored.activeThreadId);
    setQuery(restored.query);
    setInput(restored.input);
    setAttachments(restored.attachments);
    setIsPlusMenuOpen(restored.isPlusMenuOpen);
    setIsSlashMenuOpen(restored.isSlashMenuOpen);
    setLoadingThreadId(null);
    bump();
    bumpThreads();

    lastProjectKeyRef.current = nextKey;
  }, [projectKey]);
}
