import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { truncateMiddle } from "../shared/truncate.js";
import { requirePermission } from "./access.js";
import { asRecord, invalidArguments, optionalNumber, requireString } from "./args.js";
import { USER_AGENT } from "./fetch_url.js";
import { numberProperty, objectSchema, stringProperty } from "./schema.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const SEARCH_ORIGIN = "https://html.duckduckgo.com";
const MAX_RESULTS = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function formatSearchResults(query: string, results: readonly SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = results.map((result, index) => {
    const title = result.title.trim() || result.url;
    const snippet = result.snippet.trim();
    return snippet.length > 0
      ? `${index + 1}. ${title}\n   ${result.url}\n   ${snippet}`
      : `${index + 1}. ${title}\n   ${result.url}`;
  });
  return `Results for "${query}":\n${lines.join("\n")}`;
}

/** DuckDuckGo's HTML endpoint needs no key; results are parsed from its markup. */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkPattern)) {
    if (results.length >= MAX_RESULTS) break;
    const rawHref = match[1] ?? "";
    const title = match[2] ?? "";
    let url = rawHref;
    try {
      const parsed = new URL(rawHref, "https://duckduckgo.com");
      const target = parsed.searchParams.get("uddg");
      url = target ? decodeURIComponent(target) : parsed.toString();
    } catch {
      url = rawHref;
    }
    results.push({
      title: title.replace(/<[^>]+>/g, "").trim(),
      url,
      snippet: "",
    });
  }
  return results;
}

export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description = "Search the web (DuckDuckGo) and return result titles and URLs.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      query: stringProperty("The search query."),
      max_results: numberProperty(
        `Maximum number of results to return (default 5, max ${MAX_RESULTS}).`,
      ),
      timeout_ms: numberProperty("Timeout in milliseconds."),
    },
    ["query"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const query = requireString(args, "query");
      const maxResults = Math.min(
        Math.max(optionalNumber(args, "max_results") ?? 5, 1),
        MAX_RESULTS,
      );
      const timeoutMs = Math.min(
        Math.max(optionalNumber(args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS, 1_000),
        120_000,
      );
      const denied = await requirePermission(ctx, {
        tool: this.name,
        action: "network",
        title: `Web search: ${query}`,
        resource: SEARCH_ORIGIN,
      });
      if (denied !== null) return denied;
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `${SEARCH_ORIGIN}/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html" },
        });
        if (!response.ok) {
          return { ok: false, output: `web_search: provider returned HTTP ${response.status}` };
        }
        const html = await response.text();
        const results = parseDuckDuckGoResults(html).slice(0, maxResults);
        const output = truncateMiddle(formatSearchResults(query, results), 12_000, "results");
        return {
          ok: true,
          output: output.text,
          summary: `${results.length} results for "${query}"`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, output: `web_search: request failed: ${message}` };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const webSearchTool = new WebSearchTool();
