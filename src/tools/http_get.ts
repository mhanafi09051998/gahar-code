import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { isBlockedHostname, safeLookup } from "../security/network.js";

export const MAX_REDIRECTS = 5;

export interface HttpGetOptions {
  signal: AbortSignal;
  maxBytes: number;
  headers: Record<string, string>;
  /** Skip the private-network guard (explicit opt-in only). */
  allowPrivateNetwork: boolean;
}

export interface HttpGetResponse {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

export class HttpGetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpGetError";
  }
}

/** Throws when the URL is not http(s) or names a blocked host. */
export function assertFetchable(url: URL, allowPrivateNetwork: boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpGetError(`only http and https URLs are supported: ${url.href}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new HttpGetError("URLs with embedded credentials are not allowed");
  }
  if (!allowPrivateNetwork && isBlockedHostname(url.hostname)) {
    throw new HttpGetError(
      `refusing to fetch ${url.hostname}: localhost, private, link-local and metadata addresses are blocked`,
    );
  }
}

function once(url: URL, options: HttpGetOptions): Promise<IncomingMessage> {
  assertFetchable(url, options.allowPrivateNetwork);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: "GET",
        headers: { ...options.headers, "accept-encoding": "identity" },
        signal: options.signal,
        ...(options.allowPrivateNetwork ? {} : { lookup: safeLookup }),
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    response.on("data", (chunk: Buffer) => {
      if (truncated) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        response.destroy();
        resolve({ body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
      }
    });
    response.on("end", () => resolve({ body: Buffer.concat(chunks), truncated }));
    response.on("error", (error) => {
      if (!truncated) reject(error);
    });
  });
}

/** GET with manual redirects so every hop is re-validated against the SSRF guard. */
export async function httpGet(input: URL, options: HttpGetOptions): Promise<HttpGetResponse> {
  let url = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await once(url, options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && typeof location === "string") {
      response.resume();
      url = new URL(location, url);
      continue;
    }
    const { body, truncated } = await readCapped(response, options.maxBytes);
    return {
      url: url.href,
      status,
      statusText: response.statusMessage ?? "",
      contentType: response.headers["content-type"] ?? "",
      body,
      truncated,
    };
  }
  throw new HttpGetError(`too many redirects (more than ${MAX_REDIRECTS})`);
}
