const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (_match, name: string) => {
    return ENTITIES[name.toLowerCase()] ?? "";
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * Turns HTML into readable text. <pre> blocks keep their whitespace and are
 * fenced so code samples survive; everything else collapses to plain lines.
 */
export function htmlToText(html: string): string {
  const blocks: string[] = [];
  const withoutNoise = html
    .replace(/\uE000/g, "")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
      blocks.push(`\n\`\`\`\n${decodeEntities(stripTags(inner)).replace(/\n+$/, "")}\n\`\`\`\n`);
      return `\n\uE000${blocks.length - 1}\uE000\n`;
    });
  const text = decodeEntities(
    stripTags(withoutNoise.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")),
  );
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (line.length === 0 && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => blocks[Number(index)] ?? "")
    .trim();
}
