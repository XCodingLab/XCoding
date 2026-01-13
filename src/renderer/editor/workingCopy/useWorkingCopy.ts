import { useEffect, useRef, useState } from "react";
import type { WorkingCopySnapshot } from "./workingCopyTypes";
import { workingCopyManager } from "./WorkingCopyManager";
import type { WorkingCopy } from "./WorkingCopy";

export function useWorkingCopy(slot: number, relPath: string) {
  const wcRef = useRef<WorkingCopy | null>(null);
  const [snapshot, setSnapshot] = useState<WorkingCopySnapshot | null>(null);

  useEffect(() => {
    const wc = workingCopyManager.acquire(slot, relPath);
    wcRef.current = wc;
    const dispose = wc.subscribe((next) => setSnapshot(next));
    return () => {
      dispose();
      wcRef.current = null;
      workingCopyManager.release(slot, relPath);
    };
  }, [relPath, slot]);

  return { workingCopy: wcRef.current, snapshot };
}

