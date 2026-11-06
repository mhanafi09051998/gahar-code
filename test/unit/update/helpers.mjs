import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = "example/gahar-code";
export const TARBALL = Buffer.from("fake tarball bytes for tests");

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Local stand-in for api.github.com and github.com. `routes` maps a request
 * path to { status, body, json }. Every request is recorded in `requests`.
 */
export async function startMockGitHub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    const route = routes[req.url ?? ""];
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = route.json !== undefined ? JSON.stringify(route.json) : (route.body ?? "");
    res.writeHead(route.status ?? 200).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) =>
    fetch(String(url).replace(/^https:\/\/(api\.)?github\.com/, base), init);
  return {
    requests,
    fetchImpl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function releaseRoutes({ tag = "v0.2.0", tarball = TARBALL, checksum } = {}) {
  const digest = checksum ?? sha256(tarball);
  return {
    [`/repos/${REPO}/releases/latest`]: {
      json: { tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}` },
    },
    [`/${REPO}/releases/download/${tag}/gahar-code.tgz`]: { body: tarball },
    [`/${REPO}/releases/download/${tag}/gahar-code.tgz.sha256`]: {
      body: `${digest}  gahar-code.tgz\n`,
    },
  };
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gahar-update-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
