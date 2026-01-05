export type JsonRpcRequest = { id: number; method: string; params?: unknown };
export type JsonRpcNotification = { method: string; params?: unknown };
export type JsonRpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: { code?: number; message: string; data?: unknown } };

export type JsonRpcIncoming =
  | JsonRpcResponse
  | (JsonRpcNotification & { id?: undefined })
  | (JsonRpcRequest & { id: number });

export function safeJsonParseLine(line: string): { ok: true; value: JsonRpcIncoming } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(line) as JsonRpcIncoming };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "parse_error" };
  }
}

export class JsonlStreamParser {
  private buffer = "";

  feed(chunk: string): { messages: JsonRpcIncoming[]; errors: string[] } {
    this.buffer += chunk;
    const messages: JsonRpcIncoming[] = [];
    const errors: string[] = [];

    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;

      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = rawLine.trim();
      if (!line) continue;

      const parsed = safeJsonParseLine(line);
      if (!parsed.ok) {
        errors.push(`${parsed.error}\n${line}`);
        continue;
      }
      messages.push(parsed.value);
    }

    return { messages, errors };
  }
}

