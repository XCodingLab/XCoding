import { BrowserView } from "electron";
import { broadcast, mainWindow } from "../app/windowManager";

type PreviewEntry = {
  id: string;
  view: BrowserView;
  url: string;
  bounds?: { x: number; y: number; width: number; height: number };
  preserveLog: boolean;
  emulation: { mode: "desktop" | "phone" | "tablet"; baseUserAgent: string };
  network: { byId: Map<string, PreviewNetworkEntry>; order: string[] };
};

const previews = new Map<string, PreviewEntry>();
let activePreviewId: string | null = null;

type PreviewNetworkEntry = {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  startedAt: number;
  status: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  requestPostData?: string;
  responseHeaders?: Record<string, string>;
  encodedDataLength?: number;
  finishedAt?: number;
  errorText?: string;
};

const MAX_NETWORK_ENTRIES = 200;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k);
    if (!key) continue;
    if (typeof v === "string") out[key] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[key] = String(v);
    else if (v == null) out[key] = "";
    else out[key] = String((v as any).value ?? v);
  }
  return out;
}

function getOrInitNetworkEntry(preview: PreviewEntry, requestId: string): PreviewNetworkEntry {
  const existing = preview.network.byId.get(requestId);
  if (existing) return existing;
  const next: PreviewNetworkEntry = {
    requestId,
    url: "",
    method: "",
    resourceType: "",
    startedAt: Date.now(),
    status: 0
  };
  preview.network.byId.set(requestId, next);
  preview.network.order.push(requestId);
  if (preview.network.order.length > MAX_NETWORK_ENTRIES) {
    const evict = preview.network.order.splice(0, preview.network.order.length - MAX_NETWORK_ENTRIES);
    for (const id of evict) preview.network.byId.delete(id);
  }
  return next;
}

function broadcastNetwork(previewId: string, entry: PreviewNetworkEntry) {
  broadcast("preview:network", {
    previewId,
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    type: entry.resourceType,
    timestamp: entry.startedAt,
    durationMs: entry.finishedAt ? Math.max(0, entry.finishedAt - entry.startedAt) : null,
    sizeBytes: typeof entry.encodedDataLength === "number" ? entry.encodedDataLength : null,
    errorText: entry.errorText ?? null
  });
}

function base64DecodedByteLength(b64: string) {
  const len = b64.length;
  if (!len) return 0;
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

function quoteBashSingle(input: string) {
  return `'${String(input).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellSingle(input: string) {
  return `'${String(input).replace(/'/g, "''")}'`;
}

function buildCurlCommandForPlatform({
  platform,
  url,
  method,
  headers,
  postData,
  location
}: {
  platform: NodeJS.Platform;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  location: boolean;
}) {
  const isWin = platform === "win32";
  const quote = isWin ? quotePowerShellSingle : quoteBashSingle;
  const cmd = isWin ? "curl.exe" : "curl";
  const parts: string[] = [cmd];
  if (location) parts.push("--location");
  if (method) parts.push("--request", method);
  parts.push(quote(url));

  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).trim();
    if (!key) continue;
    // HTTP/2 pseudo headers can't be set via curl -H.
    if (key.startsWith(":")) continue;
    parts.push("-H", quote(`${key}: ${String(v)}`));
  }

  if (typeof postData === "string" && postData.length) {
    parts.push("--data-raw", quote(postData));
  }

  return parts.join(" ");
}

function applyEmulation(preview: PreviewEntry) {
  const mode = preview.emulation.mode;
  const wc = preview.view.webContents;
  if (mode === "desktop") {
    try {
      wc.setZoomFactor(1);
    } catch {
      // ignore
    }
    const dbg = wc.debugger;
    if (dbg.isAttached()) {
      void dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => void 0);
      void dbg
        .sendCommand("Emulation.setUserAgentOverride", { userAgent: preview.emulation.baseUserAgent })
        .catch(() => void 0);
    }
    return;
  }

  const bounds = preview.bounds;
  if (!bounds || bounds.width <= 1 || bounds.height <= 1) return;
  // Height-first fit (用户期望：设备预览尽可能“高度占满”，宽度按比例缩放)。
  const targetCssHeight = mode === "phone" ? 812 : 1024;
  const zoom = Math.max(0.1, Math.min(8, bounds.height / targetCssHeight));
  try {
    wc.setZoomFactor(zoom);
  } catch {
    // ignore
  }
  const dbg = wc.debugger;
  if (!dbg.isAttached()) return;
  const uaSuffix = mode === "phone" ? " Mobile" : "";
  const ua = preview.emulation.baseUserAgent.includes("Mobile") ? preview.emulation.baseUserAgent : `${preview.emulation.baseUserAgent}${uaSuffix}`;
  void dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: ua }).catch(() => void 0);
  void dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true }).catch(() => void 0);
}

function attachPreviewDebugger(previewId: string, preview: PreviewEntry) {
  const view = preview.view;
  const wc = view.webContents;
  const debuggerApi = wc.debugger;
  try {
    debuggerApi.attach("1.3");
  } catch {
    return;
  }

  debuggerApi.on("message", (_event, method, params) => {
    if (method === "Runtime.consoleAPICalled") {
      const level = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args.map((a: { value?: unknown; description?: unknown }) => String(a.value ?? a.description ?? "")).join(" ");
      broadcast("preview:console", { previewId, level, text, timestamp: Date.now() });
      return;
    }

    const entry = previews.get(previewId);
    if (!entry) return;
    if (method === "Network.requestWillBeSent") {
      const requestId = String((params as any).requestId ?? "");
      if (!requestId) return;
      const req = (params as any).request ?? {};
      const reqUrl = String(req.url ?? "");
      // Ignore internal/no-op navigations that otherwise show up as an empty ERR entry on first open.
      if (!reqUrl || reqUrl === "about:blank" || reqUrl.startsWith("devtools://")) return;
      const wallTime = (params as any).wallTime;
      const startedAt = typeof wallTime === "number" ? Math.floor(wallTime * 1000) : Date.now();
      const network = getOrInitNetworkEntry(entry, requestId);
      network.url = reqUrl || String(network.url ?? "");
      network.method = String(req.method ?? network.method ?? "");
      network.resourceType = String((params as any).type ?? network.resourceType ?? "");
      network.startedAt = startedAt || network.startedAt;
      network.requestHeaders = normalizeHeaders(req.headers ?? network.requestHeaders ?? {});
      if (typeof req.postData === "string") network.requestPostData = req.postData;
      broadcastNetwork(previewId, network);
      return;
    }

    if (method === "Network.requestWillBeSentExtraInfo") {
      const requestId = String((params as any).requestId ?? "");
      if (!requestId) return;
      const network = getOrInitNetworkEntry(entry, requestId);
      const headers = (params as any).headers;
      if (headers) network.requestHeaders = normalizeHeaders(headers);
      broadcastNetwork(previewId, network);
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = String((params as any).requestId ?? "");
      if (!requestId) return;
      const response = (params as any).response ?? {};
      const network = getOrInitNetworkEntry(entry, requestId);
      network.url = String(response.url ?? network.url ?? "");
      network.resourceType = String((params as any).type ?? network.resourceType ?? "");
      network.status = Number(response.status ?? network.status ?? 0);
      network.statusText = typeof response.statusText === "string" ? response.statusText : network.statusText;
      network.mimeType = typeof response.mimeType === "string" ? response.mimeType : network.mimeType;
      network.responseHeaders = normalizeHeaders(response.headers ?? network.responseHeaders ?? {});
      broadcastNetwork(previewId, network);
      return;
    }

    if (method === "Network.responseReceivedExtraInfo") {
      const requestId = String((params as any).requestId ?? "");
      if (!requestId) return;
      const network = getOrInitNetworkEntry(entry, requestId);
      const headers = (params as any).headers;
      if (headers) network.responseHeaders = normalizeHeaders(headers);
      broadcastNetwork(previewId, network);
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = String((params as any).requestId ?? "");
      if (!requestId) return;
      const network = getOrInitNetworkEntry(entry, requestId);
      network.encodedDataLength = Number((params as any).encodedDataLength ?? network.encodedDataLength ?? 0);
      network.finishedAt = Date.now();
      broadcastNetwork(previewId, network);
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = String((params as any).requestId ?? "");
      if (!requestId) return;
      const network = getOrInitNetworkEntry(entry, requestId);
      network.errorText = String((params as any).errorText ?? "failed");
      network.finishedAt = Date.now();
      broadcastNetwork(previewId, network);
    }
  });

  void debuggerApi.sendCommand("Runtime.enable");
  void debuggerApi.sendCommand("Network.enable");
  applyEmulation(preview);
}

export function createPreview(previewId: string, url: string) {
  if (!mainWindow) return { ok: false as const, reason: "no_window" as const };
  if (previews.has(previewId)) return { ok: true as const };

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const baseUserAgent = (() => {
    try {
      return view.webContents.getUserAgent();
    } catch {
      return "";
    }
  })();
  const entry: PreviewEntry = {
    id: previewId,
    view,
    url,
    preserveLog: false,
    emulation: { mode: "desktop", baseUserAgent },
    network: { byId: new Map(), order: [] }
  };
  previews.set(previewId, entry);
  attachPreviewDebugger(previewId, entry);
  void view.webContents.loadURL(url);
  return { ok: true as const };
}

export function showPreview(previewId: string, bounds: { x: number; y: number; width: number; height: number }) {
  if (!mainWindow) return { ok: false as const, reason: "no_window" as const };
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };

  if (activePreviewId && activePreviewId !== previewId) {
    const prev = previews.get(activePreviewId);
    if (prev) mainWindow.removeBrowserView(prev.view);
  }
  activePreviewId = previewId;

  mainWindow.addBrowserView(entry.view);
  entry.bounds = bounds;
  entry.view.setBounds(bounds);
  entry.view.setAutoResize({ width: false, height: false });
  applyEmulation(entry);
  return { ok: true as const };
}

export function hidePreview(previewId: string) {
  if (!mainWindow) return { ok: true as const };
  if (!activePreviewId || activePreviewId !== previewId) return { ok: true as const };
  const entry = previews.get(previewId);
  if (entry) mainWindow.removeBrowserView(entry.view);
  activePreviewId = null;
  return { ok: true as const };
}

export function setPreviewBounds(previewId: string, bounds: { x: number; y: number; width: number; height: number }) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  entry.bounds = bounds;
  entry.view.setBounds(bounds);
  applyEmulation(entry);
  return { ok: true as const };
}

export function navigatePreview(previewId: string, url: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  entry.url = url;
  if (!entry.preserveLog) {
    entry.network.byId.clear();
    entry.network.order = [];
    broadcast("preview:resetLogs", { previewId });
  }
  void entry.view.webContents.loadURL(url);
  return { ok: true as const };
}

export function reloadPreview(previewId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  if (!entry.preserveLog) {
    entry.network.byId.clear();
    entry.network.order = [];
    broadcast("preview:resetLogs", { previewId });
  }
  try {
    entry.view.webContents.reload();
  } catch {
    // ignore
  }
  return { ok: true as const };
}

export function setPreviewPreserveLog(previewId: string, preserve: boolean) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  entry.preserveLog = Boolean(preserve);
  return { ok: true as const };
}

export function setPreviewEmulation(previewId: string, mode: "desktop" | "phone" | "tablet") {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  entry.emulation.mode = mode;
  applyEmulation(entry);
  return { ok: true as const };
}

export function previewNetworkGetEntry(previewId: string, requestId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  const network = entry.network.byId.get(requestId);
  if (!network) return { ok: false as const, reason: "request_not_found" as const };
  return {
    ok: true as const,
    entry: {
      requestId: network.requestId,
      url: network.url,
      method: network.method,
      type: network.resourceType,
      status: network.status,
      statusText: network.statusText ?? "",
      mimeType: network.mimeType ?? "",
      startedAt: network.startedAt,
      finishedAt: network.finishedAt ?? 0,
      durationMs: network.finishedAt ? Math.max(0, network.finishedAt - network.startedAt) : 0,
      sizeBytes: typeof network.encodedDataLength === "number" ? network.encodedDataLength : 0,
      errorText: network.errorText ?? "",
      requestHeaders: network.requestHeaders ?? {},
      requestPostData: network.requestPostData ?? "",
      responseHeaders: network.responseHeaders ?? {}
    }
  };
}

export async function previewNetworkGetResponseBody(previewId: string, requestId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  const network = entry.network.byId.get(requestId);
  if (!network) return { ok: false as const, reason: "request_not_found" as const };

  const sizeHint = typeof network.encodedDataLength === "number" ? network.encodedDataLength : 0;
  if (sizeHint > MAX_RESPONSE_BYTES) return { ok: false as const, reason: "too_large" as const, sizeBytes: sizeHint };

  const dbg = entry.view.webContents.debugger;
  if (!dbg.isAttached()) return { ok: false as const, reason: "debugger_unavailable" as const };
  try {
    const res = (await dbg.sendCommand("Network.getResponseBody", { requestId })) as any;
    const body = String(res?.body ?? "");
    const base64Encoded = Boolean(res?.base64Encoded);
    const sizeBytes = base64Encoded ? base64DecodedByteLength(body) : Buffer.byteLength(body, "utf8");
    if (sizeBytes > MAX_RESPONSE_BYTES) return { ok: false as const, reason: "too_large" as const, sizeBytes };
    return { ok: true as const, body, base64Encoded, sizeBytes, mimeType: network.mimeType ?? "" };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "get_response_body_failed" };
  }
}

export function previewNetworkBuildCurl(previewId: string, requestId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  const network = entry.network.byId.get(requestId);
  if (!network) return { ok: false as const, reason: "request_not_found" as const };
  const curl = buildCurlCommandForPlatform({
    platform: process.platform,
    url: network.url,
    method: network.method,
    headers: network.requestHeaders ?? {},
    postData: network.requestPostData,
    location: true
  });
  return { ok: true as const, curl };
}

export async function previewNetworkClearBrowserCache(previewId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: false as const, reason: "not_found" as const };
  const dbg = entry.view.webContents.debugger;
  if (!dbg.isAttached()) return { ok: false as const, reason: "debugger_unavailable" as const };
  try {
    await dbg.sendCommand("Network.clearBrowserCache");
    await dbg.sendCommand("Network.clearBrowserCookies");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, reason: e instanceof Error ? e.message : "clear_cache_failed" };
  }
}

export function destroyPreview(previewId: string) {
  const entry = previews.get(previewId);
  if (!entry) return { ok: true as const };
  if (mainWindow) mainWindow.removeBrowserView(entry.view);
  try {
    entry.view.webContents.debugger.detach();
  } catch {
    // ignore
  }
  entry.view.webContents.close();
  previews.delete(previewId);
  if (activePreviewId === previewId) activePreviewId = null;
  return { ok: true as const };
}
