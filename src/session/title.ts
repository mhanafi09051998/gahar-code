export const MAX_TITLE_LENGTH = 60;

/** Derives a session title from the first user message (no LLM call). */
export function deriveTitle(input: string, maxLength = MAX_TITLE_LENGTH): string {
  const firstLine = input.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "New session";
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/** True when the title is still the placeholder and should be replaced. */
export function isPlaceholderTitle(title: string): boolean {
  return title.trim().length === 0 || title === "New session";
}
