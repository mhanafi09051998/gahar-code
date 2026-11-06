import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { truncateMiddle } from "../shared/truncate.js";
import { asRecord, invalidArguments, optionalNumber, requireString } from "./args.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 40_000;
const USER_AGENT = "GaharCode/0.1 (+https://github.com/gahar-code/gahar-code)";

export function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutScripts
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1] !== ""))
    .join("\n")
    .trim();
}

export class FetchUrlTool implements Tool {
  readonly name = "fetch_url";
  readonly description = "Fetch an http or https URL and return its body as text (HTML is stripped to plain text).";
  readonly readOnly = true;
  readonly parameters: JsonSchema = objectSchema(
    {
      url: stringProperty("Absolute http or https URL to fetch."),
      timeout_ms: numberProperty(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`),
    },
    ["url"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const input = requireString(args, "url");
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        return { ok: false, output: `fetch_url: invalid URL: ${input}` };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, output: `fetch_url: only http and https URLs are supported: ${input}` };
      }
      const timeoutMs = Math.min(Math.max(optionalNumber(args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS, 1_000), 120_000);
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json,*/*;q=0.8" },
        });
        const contentType = response.headers.get("content-type") ?? "";
        const buffer = Buffer.from(await response.arrayBuffer());
        const truncatedByBytes = buffer.length > MAX_BYTES;
        const raw = buffer.subarray(0, MAX_BYTES).toString("utf8");
        const text = contentType.includes("html") ? stripHtml(raw) : raw;
        const body = truncateMiddle(text, MAX_CHARS, "body");
        const suffix = truncatedByBytes || body.truncated ? "\n... [response truncated] ..." : "";
        return {
          ok: response.ok,
          output: `HTTP ${response.status} ${response.statusText} (${contentType || "unknown type"})\n\n${body.text}${suffix}`,
          summary: `HTTP ${response.status}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `fetch_url: request failed: ${message}` };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const fetchUrlTool = new FetchUrlTool();
