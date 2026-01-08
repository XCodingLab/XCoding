import { useEffect, useRef } from "react";

type Props = {
  previewId: string;
  url: string;
  isActive: boolean;
  emulationMode: "desktop" | "phone" | "tablet";
};

function clampBounds(raw: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.max(0, Math.floor(raw.x)),
    y: Math.max(0, Math.floor(raw.y)),
    width: Math.max(1, Math.floor(raw.width)),
    height: Math.max(1, Math.floor(raw.height))
  };
}

function computeEmulatedBounds(rect: DOMRect, mode: Props["emulationMode"]) {
  // Desktop: fill available space.
  if (mode === "desktop") {
    return clampBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }

  // Phone/Tablet: height fills, width follows device aspect ratio and is centered.
  const target = mode === "phone" ? { w: 375, h: 812 } : { w: 768, h: 1024 };
  const height = rect.height;
  const width = Math.min(rect.width, (height * target.w) / target.h);
  const x = rect.x + (rect.width - width) / 2;
  const y = rect.y;
  return clampBounds({ x, y, width, height });
}

export default function PreviewView({ previewId, url, isActive, emulationMode }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pendingBoundsRafRef = useRef<number | null>(null);
  const emulationModeRef = useRef<Props["emulationMode"]>(emulationMode);
  const urlRef = useRef(url);

  useEffect(() => {
    emulationModeRef.current = emulationMode;
  }, [emulationMode]);

  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;

    async function ensureCreated() {
      await window.xcoding.preview.create({ previewId, url: urlRef.current });
    }

    async function show() {
      if (!hostRef.current) return;
      const rect = hostRef.current.getBoundingClientRect();
      await window.xcoding.preview.show({ previewId, bounds: computeEmulatedBounds(rect, emulationModeRef.current) });
    }

    async function hide() {
      await window.xcoding.preview.hide({ previewId });
    }

    async function setBounds() {
      if (!hostRef.current) return;
      const rect = hostRef.current.getBoundingClientRect();
      await window.xcoding.preview.setBounds({ previewId, bounds: computeEmulatedBounds(rect, emulationModeRef.current) });
    }

    void ensureCreated().then(() => {
      if (cancelled) return;
      if (isActive) void show();
      else void hide();
    });

    if (hostRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (!isActive) return;
        if (pendingBoundsRafRef.current != null) return;
        pendingBoundsRafRef.current = requestAnimationFrame(() => {
          pendingBoundsRafRef.current = null;
          void setBounds();
        });
      });
      resizeObserver.observe(hostRef.current);
    }

    return () => {
      cancelled = true;
      void window.xcoding.preview.hide({ previewId });
      resizeObserver?.disconnect();
      if (pendingBoundsRafRef.current != null) cancelAnimationFrame(pendingBoundsRafRef.current);
      pendingBoundsRafRef.current = null;
    };
  }, [isActive, previewId]);

  useEffect(() => {
    if (!isActive) return;
    void window.xcoding.preview.navigate({ previewId, url });
  }, [isActive, previewId, url]);

  useEffect(() => {
    if (!isActive) return;
    void window.xcoding.preview.setEmulation({ previewId, mode: emulationMode });
  }, [emulationMode, isActive, previewId]);

  useEffect(() => {
    if (!isActive) return;
    if (!hostRef.current) return;
    const rect = hostRef.current.getBoundingClientRect();
    void window.xcoding.preview.setBounds({ previewId, bounds: computeEmulatedBounds(rect, emulationMode) });
  }, [emulationMode, isActive, previewId]);

  return (
    <div className="h-full w-full overflow-hidden bg-[var(--vscode-editor-background)]">
      <div className="h-full w-full" ref={hostRef} />
    </div>
  );
}
