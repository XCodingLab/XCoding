export function findWordBounds(text: string, cursor: number) {
  const i = Math.max(0, Math.min(text.length, cursor));
  let start = i;
  while (start > 0 && !/\s/.test(text[start - 1] || "")) start -= 1;
  let end = i;
  while (end < text.length && !/\s/.test(text[end] || "")) end += 1;
  return { start, end };
}

export function findSlashToken(text: string, cursor: number) {
  const { start, end } = findWordBounds(text, cursor);
  const token = text.slice(start, end);
  if (!token.startsWith("/")) return null;
  if (start > 0 && !/\s/.test(text[start - 1] || "")) return null;
  const query = token.slice(1);
  return { start, end, token, query };
}

export function findAtToken(text: string, cursor: number) {
  const { start, end } = findWordBounds(text, cursor);
  const token = text.slice(start, end);
  if (!token.startsWith("@")) return null;
  if (start > 0 && !/\s/.test(text[start - 1] || "")) return null;
  const query = token.slice(1);
  return { start, end, token, query };
}

