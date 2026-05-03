export function splitJsonLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function safeJsonParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

export function buildJsonl(lines: string[]): string {
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function filterJsonLines<T>(
  text: string | null,
  shouldKeep: (record: T | null, rawLine: string) => boolean,
): {
  text: string;
  removedCount: number;
} {
  if (!text) {
    return { text: "", removedCount: 0 };
  }

  const kept: string[] = [];
  let removedCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      continue;
    }

    const parsed = safeJsonParse<T>(trimmed);

    if (shouldKeep(parsed, rawLine)) {
      kept.push(rawLine);
      continue;
    }

    removedCount += 1;
  }

  return {
    text: buildJsonl(kept),
    removedCount,
  };
}
