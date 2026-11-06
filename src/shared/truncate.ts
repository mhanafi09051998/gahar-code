export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export function truncateMiddle(input: string, maxChars: number, label = "output"): TruncateResult {
  const originalLength = input.length;
  if (originalLength <= maxChars || maxChars <= 0) {
    return { text: input, truncated: false, originalLength };
  }
  const marker = `\n... [${label} truncated, ${originalLength - maxChars} characters omitted] ...\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.6);
  const tailLength = available - headLength;
  return {
    text: input.slice(0, headLength) + marker + (tailLength > 0 ? input.slice(-tailLength) : ""),
    truncated: true,
    originalLength,
  };
}

export function truncateLines(input: string, maxLines: number): TruncateResult {
  const lines = input.split("\n");
  if (lines.length <= maxLines) {
    return { text: input, truncated: false, originalLength: input.length };
  }
  const marker = `\n... [output truncated, ${lines.length - maxLines} lines omitted] ...\n`;
  return {
    text: lines.slice(0, maxLines).join("\n") + marker,
    truncated: true,
    originalLength: input.length,
  };
}

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
