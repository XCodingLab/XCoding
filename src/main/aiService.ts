type StartChatRequest = {
  id: string;
  type: "chat:start";
  apiBase: string;
  apiKey?: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

type CancelChatRequest = { id: string; type: "chat:cancel" };

type RequestMessage = StartChatRequest | CancelChatRequest;

type EventMessage =
  | { type: "event"; payload: { kind: "chunk"; id: string; text: string } }
  | { type: "event"; payload: { kind: "done"; id: string } }
  | { type: "event"; payload: { kind: "error"; id: string; error: string } };

const abortById = new Map<string, AbortController>();

function send(msg: EventMessage) {
  if (typeof process.send === "function") process.send(msg);
}

function normalizeApiBase(apiBase: string) {
  const trimmed = apiBase.trim().replace(/\/+$/, "");
  return trimmed || "https://api.openai.com";
}

function parseSseLines(buffer: string) {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";
  const events: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.trim() === "") {
      if (current) events.push(current);
      current = "";
      continue;
    }
    current += `${line}\n`;
  }
  return { events, remaining: remaining ? `${current}${remaining}` : current };
}

async function handleStart(msg: StartChatRequest) {
  const apiBase = normalizeApiBase(msg.apiBase);
  const url = `${apiBase}/v1/chat/completions`;
  const controller = new AbortController();
  abortById.set(msg.id, controller);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(msg.apiKey ? { authorization: `Bearer ${msg.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: msg.model,
        messages: msg.messages,
        stream: true
      }),
      signal: controller.signal
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`http_${res.status}: ${text || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      const parsed = parseSseLines(pending);
      pending = parsed.remaining;

      for (const block of parsed.events) {
        const dataLines = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice("data:".length).trim());
        for (const raw of dataLines) {
          if (!raw) continue;
          if (raw === "[DONE]") {
            send({ type: "event", payload: { kind: "done", id: msg.id } });
            abortById.delete(msg.id);
            return;
          }
          try {
            const json = JSON.parse(raw);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length) {
              send({ type: "event", payload: { kind: "chunk", id: msg.id, text: delta } });
            }
          } catch {
            // ignore parse errors for non-standard streams
          }
        }
      }
    }

    send({ type: "event", payload: { kind: "done", id: msg.id } });
  } catch (e) {
    if (controller.signal.aborted) {
      send({ type: "event", payload: { kind: "done", id: msg.id } });
      return;
    }
    send({ type: "event", payload: { kind: "error", id: msg.id, error: e instanceof Error ? e.message : "error" } });
  } finally {
    abortById.delete(msg.id);
  }
}

process.on("message", (msg: RequestMessage) => {
  if (!msg || typeof msg !== "object" || typeof (msg as any).type !== "string") return;

  if (msg.type === "chat:cancel") {
    const c = abortById.get(msg.id);
    if (c) c.abort();
    abortById.delete(msg.id);
    send({ type: "event", payload: { kind: "done", id: msg.id } });
    return;
  }

  if (msg.type === "chat:start") {
    void handleStart(msg);
  }
});

