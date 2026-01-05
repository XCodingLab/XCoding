import { useEffect, useRef } from "react";

type Props = {
  previewId: string;
  url: string;
  isActive: boolean;
};

function clampBounds(rect: DOMRect) {
  return {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height))
  };
}

export default function PreviewView({ previewId, url, isActive }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;

    async function ensureCreated() {
      await window.xcoding.preview.create({ previewId, url });
    }

    async function show() {
      if (!hostRef.current) return;
      const rect = hostRef.current.getBoundingClientRect();
      await window.xcoding.preview.show({ previewId, bounds: clampBounds(rect) });
    }

    async function hide() {
      await window.xcoding.preview.hide({ previewId });
    }

    async function setBounds() {
      if (!hostRef.current) return;
      const rect = hostRef.current.getBoundingClientRect();
      await window.xcoding.preview.setBounds({ previewId, bounds: clampBounds(rect) });
    }

    void ensureCreated().then(() => {
      if (cancelled) return;
      if (isActive) void show();
      else void hide();
    });

    if (hostRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (!isActive) return;
        void setBounds();
      });
      resizeObserver.observe(hostRef.current);
    }

    return () => {
      cancelled = true;
      void window.xcoding.preview.hide({ previewId });
      resizeObserver?.disconnect();
    };
  }, [isActive, previewId]);

  useEffect(() => {
    if (!isActive) return;
    void window.xcoding.preview.navigate({ previewId, url });
  }, [isActive, previewId, url]);

  return (
    <div className="h-full w-full overflow-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="h-full w-full" ref={hostRef} />
    </div>
  );
}
