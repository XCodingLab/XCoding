type DiffOp = { kind: "eq" | "add" | "del"; text: string };

export function countMyersLineDiff(oldText: string, newText: string, maxLines = 8000) {
  const a = String(oldText ?? "").replace(/\r\n/g, "\n").split("\n");
  const b = String(newText ?? "").replace(/\r\n/g, "\n").split("\n");
  if (a.length > maxLines || b.length > maxLines) return null;

  const N = a.length;
  const M = b.length;
  const max = N + M;
  const v = new Map<number, number>();
  v.set(1, 0);
  const traces: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    const vNext = new Map<number, number>(v);
    traces.push(vNext);
    for (let k = -d; k <= d; k += 2) {
      const down = v.get(k + 1) ?? -1;
      const right = v.get(k - 1) ?? -1;
      let x = 0;
      if (k === -d || (k !== d && down > right)) x = down;
      else x = right + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      vNext.set(k, x);
      if (x >= N && y >= M) {
        let added = 0;
        let removed = 0;
        let cx = N;
        let cy = M;
        for (let cd = d; cd > 0; cd--) {
          const vv = traces[cd - 1]!;
          const ck = cx - cy;
          const down2 = vv.get(ck + 1) ?? -1;
          const right2 = vv.get(ck - 1) ?? -1;
          const prevK = ck === -cd || (ck !== cd && down2 > right2) ? ck + 1 : ck - 1;
          const prevX = vv.get(prevK) ?? 0;
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
          }
          if (cx === prevX) {
            added += 1;
            cy -= 1;
          } else {
            removed += 1;
            cx -= 1;
          }
        }
        return { added, removed };
      }
    }
    v.clear();
    for (const [k, val] of vNext) v.set(k, val);
  }
  return null;
}

function buildMyersOps(oldText: string, newText: string, maxLines = 8000): DiffOp[] | null {
  const a = String(oldText ?? "").replace(/\r\n/g, "\n").split("\n");
  const b = String(newText ?? "").replace(/\r\n/g, "\n").split("\n");
  if (a.length > maxLines || b.length > maxLines) return null;

  const N = a.length;
  const M = b.length;
  const max = N + M;
  const v = new Map<number, number>();
  v.set(1, 0);
  const traces: Map<number, number>[] = [];

  for (let d = 0; d <= max; d++) {
    const vNext = new Map<number, number>(v);
    traces.push(vNext);
    for (let k = -d; k <= d; k += 2) {
      const down = v.get(k + 1) ?? -1;
      const right = v.get(k - 1) ?? -1;
      let x = 0;
      if (k === -d || (k !== d && down > right)) x = down;
      else x = right + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      vNext.set(k, x);
      if (x >= N && y >= M) {
        // backtrack to build operations
        let cx = N;
        let cy = M;
        const rev: DiffOp[] = [];
        for (let cd = d; cd > 0; cd--) {
          const vv = traces[cd - 1]!;
          const ck = cx - cy;
          const down2 = vv.get(ck + 1) ?? -1;
          const right2 = vv.get(ck - 1) ?? -1;
          const prevK = ck === -cd || (ck !== cd && down2 > right2) ? ck + 1 : ck - 1;
          const prevX = vv.get(prevK) ?? 0;
          const prevY = prevX - prevK;

          while (cx > prevX && cy > prevY) {
            cx--;
            cy--;
            rev.push({ kind: "eq", text: a[cx] ?? "" });
          }
          if (cx === prevX) {
            cy -= 1;
            rev.push({ kind: "add", text: b[cy] ?? "" });
          } else {
            cx -= 1;
            rev.push({ kind: "del", text: a[cx] ?? "" });
          }
        }
        while (cx > 0 && cy > 0 && a[cx - 1] === b[cy - 1]) {
          cx--;
          cy--;
          rev.push({ kind: "eq", text: a[cx] ?? "" });
        }
        while (cx > 0) {
          cx--;
          rev.push({ kind: "del", text: a[cx] ?? "" });
        }
        while (cy > 0) {
          cy--;
          rev.push({ kind: "add", text: b[cy] ?? "" });
        }

        rev.reverse();
        // merge adjacent ops of same kind
        const out: DiffOp[] = [];
        for (const op of rev) {
          const last = out[out.length - 1];
          if (last && last.kind === op.kind) {
            last.text = `${last.text}\n${op.text}`;
          } else out.push({ ...op });
        }
        return out;
      }
    }
    v.clear();
    for (const [kk, val] of vNext) v.set(kk, val);
  }
  return null;
}

export function makeUnifiedDiff({
  oldText,
  newText,
  pathLabel,
  contextLines = 3,
  maxOutputLines = 4000
}: {
  oldText: string;
  newText: string;
  pathLabel: string;
  contextLines?: number;
  maxOutputLines?: number;
}): { diff: string; truncated: boolean } | null {
  const ops = buildMyersOps(oldText, newText);
  if (!ops) return null;

  // Expand merged op blocks back to line-level (still bounded by max lines in buildMyersOps).
  const expanded: DiffOp[] = [];
  for (const op of ops) {
    const lines = String(op.text ?? "").split("\n");
    for (const line of lines) expanded.push({ kind: op.kind, text: line });
  }

  // Find change indices.
  const changed: boolean[] = expanded.map((op) => op.kind !== "eq");
  if (!changed.some(Boolean)) return { diff: "", truncated: false };

  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < changed.length) {
    while (i < changed.length && !changed[i]) i++;
    if (i >= changed.length) break;
    const startChange = i;
    while (i < changed.length && changed[i]) i++;
    const endChange = i; // exclusive
    const start = Math.max(0, startChange - contextLines);
    const end = Math.min(changed.length, endChange + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const p = pathLabel || "unknown";
  const headerLines = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`];
  const out: string[] = [...headerLines];

  let oldLine = 1;
  let newLine = 1;
  const lineNoOld: number[] = new Array(expanded.length).fill(0);
  const lineNoNew: number[] = new Array(expanded.length).fill(0);
  for (let idx = 0; idx < expanded.length; idx++) {
    lineNoOld[idx] = oldLine;
    lineNoNew[idx] = newLine;
    const k = expanded[idx]!.kind;
    if (k === "eq") {
      oldLine++;
      newLine++;
    } else if (k === "del") {
      oldLine++;
    } else {
      newLine++;
    }
  }

  let truncated = false;
  for (const r of ranges) {
    // compute hunk header
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    let seenStart = false;
    for (let idx = r.start; idx < r.end; idx++) {
      const op = expanded[idx]!;
      const o = lineNoOld[idx]!;
      const n = lineNoNew[idx]!;
      if (!seenStart) {
        oldStart = o;
        newStart = n;
        seenStart = true;
      }
      if (op.kind === "eq") {
        oldCount++;
        newCount++;
      } else if (op.kind === "del") {
        oldCount++;
      } else {
        newCount++;
      }
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let idx = r.start; idx < r.end; idx++) {
      if (out.length >= maxOutputLines) {
        truncated = true;
        break;
      }
      const op = expanded[idx]!;
      if (op.kind === "eq") out.push(` ${op.text}`);
      else if (op.kind === "del") out.push(`-${op.text}`);
      else out.push(`+${op.text}`);
    }
    if (truncated) break;
  }

  return { diff: out.join("\n"), truncated };
}
