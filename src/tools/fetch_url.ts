import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { toErrorMessage } from "../shared/errors.js";
import { truncateMiddle } from "../shared/truncate.js";
import { VERSION } from "../shared/version.js";
import { requirePermission } from "./access.js";
import { asRecord, invalidArguments, requireString } from "./args.js";
import { htmlToText } from "./html.js";
import { assertFetchable, httpGet } from "./http_get.js";
import { objectSchema, stringProperty } from "./schema.js";

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
export const MAX_FETCH_CHARS = 50 * 1024;
export const USER_AGENT = `gahar-code/${VERSION}`;
const TEXTUAL =
  /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json)|[^;]*\+(json|xml))/i;

export interface FetchUrlOptions {
  /** Allow localhost and private networks. Off by default; GAHAR_ALLOW_PRIVATE_FETCH=1 also enables it. */
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
}

export class FetchUrlTool implements Tool {
  readonly name = "fetch_url";
  readonly description =
    "Fetch a public http or https URL and return its body as text (HTML is converted to readable text). Localhost and private networks are blocked.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    { url: stringProperty("Absolute http or https URL to fetch.") },
    ["url"],
  );
  private readonly options: FetchUrlOptions;

  constructor(options: FetchUrlOptions = {}) {
    this.options = options;
  }

  private allowPrivate(): boolean {
    return this.options.allowPrivateNetwork ?? process.env.GAHAR_ALLOW_PRIVATE_FETCH === "1";
  }

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let input: string;
    try {
      input = requireString(asRecord(rawArgs, this.name), "url");
    } catch (error) {
      return invalidArguments(this.name, error);
    }
    let url: URL;
    try {
      url = new URL(input);
      assertFetchable(url, this.allowPrivate());
    } catch (error) {
      return { ok: false, output: `fetch_url: ${toErrorMessage(error)}` };
    }
    const denied = await requirePermission(ctx, {
      tool: this.name,
      action: "network",
      title: `Fetch ${url.href}`,
      resource: url.origin,
    });
    if (denied !== null) return denied;
    return this.fetch(url, ctx);
  }

  private async fetch(url: URL, ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await httpGet(url, {
        signal,
        maxBytes: MAX_FETCH_BYTES,
        allowPrivateNetwork: this.allowPrivate(),
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,text/plain,application/json,*/*;q=0.8",
        },
      });
      const type = response.contentType || "unknown type";
      const header = `HTTP ${response.status} ${response.statusText} (${type}) ${response.url}`;
      if (response.contentType !== "" && !TEXTUAL.test(response.contentType)) {
        return {
          ok: false,
          output: `${header}\n\nfetch_url: refusing to return non-text content (${type})`,
        };
      }
      const raw = response.body.toString("utf8");
      const text = /html/i.test(response.contentType) ? htmlToText(raw) : raw;
      const body = truncateMiddle(text, MAX_FETCH_CHARS, "body");
      const suffix = response.truncated ? "\n... [response truncated at download cap] ..." : "";
      return {
        ok: response.status >= 200 && response.status < 300,
        output: `${header}\n\n${body.text}${suffix}`,
        summary: `HTTP ${response.status}`,
      };
    } catch (error) {
      const reason =
        signal.aborted && !ctx.signal.aborted
          ? `timed out after ${timeoutMs} ms`
          : toErrorMessage(error);
      return { ok: false, output: `fetch_url: request failed: ${reason}` };
    }
  }
}

export const fetchUrlTool = new FetchUrlTool();
