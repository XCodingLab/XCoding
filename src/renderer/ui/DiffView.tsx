import { useEffect, useMemo, useState } from "react";

type Props = {
  slot: number;
  path: string;
  stagedContent: string;
};

export default function DiffView({ slot, path, stagedContent }: Props) {
  const [diskContent, setDiskContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.xcoding.fs.readFile({ slot, path }).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setError(res.reason ?? "read_failed");
        return;
      }
      setDiskContent(res.content ?? "");
      setError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [slot, path]);

  const stats = useMemo(() => {
    const diskLines = diskContent.split("\n").length;
    const stagedLines = stagedContent.split("\n").length;
    return { diskLines, stagedLines };
  }, [diskContent, stagedContent]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <div className="truncate">Diff: {path}</div>
        <div className="shrink-0">
          disk {stats.diskLines}L · staged {stats.stagedLines}L
        </div>
      </div>

      {error ? <div className="text-xs text-red-400">Failed to read file: {error}</div> : null}

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
        <div className="min-h-0 overflow-hidden rounded border border-neutral-800 bg-neutral-950">
          <div className="border-b border-neutral-800 px-2 py-1 text-xs text-neutral-300">Disk</div>
          <pre className="h-[calc(100%-2rem)] overflow-auto p-2 text-[11px] leading-4 text-neutral-300">{diskContent}</pre>
        </div>
        <div className="min-h-0 overflow-hidden rounded border border-neutral-800 bg-neutral-950">
          <div className="border-b border-neutral-800 px-2 py-1 text-xs text-neutral-300">Staging</div>
          <pre className="h-[calc(100%-2rem)] overflow-auto p-2 text-[11px] leading-4 text-neutral-300">{stagedContent}</pre>
        </div>
      </div>
    </div>
  );
}
