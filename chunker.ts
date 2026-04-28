export const DEFAULT_CHUNK_LIMIT = 1600;

export function chunkMessage(text: string, limit = DEFAULT_CHUNK_LIMIT): string[] {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("chunk limit must be a positive number");
  }

  const normalized = String(text ?? "");
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized.trim();

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.6)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.6)) {
      splitAt = limit;
    }

    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [""];
}
