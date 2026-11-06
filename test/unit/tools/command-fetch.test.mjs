import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { FetchUrlTool, fetchUrlTool } from "../../../dist/tools/fetch_url.js";
import { htmlToText } from "../../../dist/tools/html.js";
import { runCommandTool } from "../../../dist/tools/run_command.js";
import { commandEnv, OutputCollector, resolveShell } from "../../../dist/tools/shell.js";
import { FAKE_KEY, fakeHandler, makeContext, makeSandbox } from "./helpers.mjs";

let box;
before(async () => {
  box = await makeSandbox();
});
after(() => box.cleanup());

const node = (script) => `node -e "${script}"`;

describe("run_command", () => {
  test("returns output and exit code on success", async () => {
    const result = await runCommandTool.execute(
      { command: node("console.log('hello')") },
      makeContext(box.workspace),
    );
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /^exit code: 0\nhello/);
  });

  test("reports non-zero exits with stderr", async () => {
    const result = await runCommandTool.execute(
      { command: node("console.error('boom'); process.exit(3)") },
      makeContext(box.workspace),
    );
    assert.equal(result.ok, false);
    assert.match(result.output, /exit code: 3/);
    assert.match(result.output, /boom/);
  });

  test("kills the command on timeout", async () => {
    const started = Date.now();
    const result = await runCommandTool.execute(
      { command: node("setTimeout(() => {}, 30000)"), timeout_ms: 1500 },
      makeContext(box.workspace),
    );
    assert.equal(result.ok, false);
    assert.match(result.output, /timed out after 1500 ms/);
    assert.ok(Date.now() - started < 10_000);
  });

  test("asks the gate, refuses outside cwd, and redacts the API key", async () => {
    const denied = await runCommandTool.execute(
      { command: "echo hi" },
      makeContext(box.workspace, { mode: "auto-edit" }),
    );
    assert.match(denied.output, /permission denied.*full-auto/);
    const handler = fakeHandler("allow");
    const allowed = makeContext(box.workspace, { mode: "ask", handler, apiKey: FAKE_KEY });
    const result = await runCommandTool.execute(
      { command: node(`console.log('${FAKE_KEY}')`) },
      allowed,
    );
    assert.equal(handler.requests[0].action, "shell");
    assert.doesNotMatch(result.output, /test0000/);
    const outside = await runCommandTool.execute(
      { command: "echo", cwd: "../outside" },
      makeContext(box.workspace),
    );
    assert.match(outside.output, /outside the workspace/);
  });

  test("PowerShell exit code follows the last statement", {
    skip: process.platform !== "win32",
  }, async () => {
    const cases = [
      ["cmd /c exit 3; Write-Output done", 0],
      ["cmd /c exit 3", 3],
      [`${node("process.stderr.write('warn')")} 2>&1`, 0],
      ["Get-Item gahar-missing-file", 1],
    ];
    process.env.GAHAR_SHELL = "powershell";
    try {
      for (const [command, code] of cases) {
        const result = await runCommandTool.execute({ command }, makeContext(box.workspace));
        assert.match(result.output, new RegExp(`^exit code: ${code}\\b`), command);
      }
    } finally {
      delete process.env.GAHAR_SHELL;
    }
  });

  test("shell helpers", () => {
    const shell = resolveShell("echo 1");
    assert.ok(shell.args.at(-1).includes("echo 1"));
    const env = commandEnv({ PATH: "/bin", OPENROUTER_API_KEY: FAKE_KEY });
    assert.deepEqual(env, { PATH: "/bin" });
    const collector = new OutputCollector(20);
    for (let i = 0; i < 100; i += 1) collector.push("abcdefghij");
    const text = collector.text();
    assert.match(text, /^abcdefghij\n\.\.\. \[output truncated, 980 characters omitted\]/);
    assert.ok(text.length < 100);
  });
});

describe("fetch_url SSRF guard", () => {
  const blocked = [
    "http://localhost/",
    "http://127.0.0.1:8080/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0/",
    "http://metadata.google.internal/",
  ];

  test("rejects private and metadata targets before any approval", async () => {
    const handler = fakeHandler("allow");
    const ctx = makeContext(box.workspace, { mode: "ask", handler });
    for (const url of blocked) {
      const result = await fetchUrlTool.execute({ url }, ctx);
      assert.equal(result.ok, false, url);
      assert.match(result.output, /refusing to fetch/, url);
    }
    assert.equal(handler.requests.length, 0);
  });

  test("rejects non-http schemes, credentials and bad input", async () => {
    const ctx = makeContext(box.workspace);
    assert.match(
      (await fetchUrlTool.execute({ url: "file:///etc/passwd" }, ctx)).output,
      /only http/,
    );
    assert.match(
      (await fetchUrlTool.execute({ url: "http://u:p@example.com/" }, ctx)).output,
      /credentials/,
    );
    assert.match((await fetchUrlTool.execute({ url: "not a url" }, ctx)).output, /Invalid URL/);
    assert.match((await fetchUrlTool.execute({}, ctx)).output, /invalid arguments/);
  });

  test("network access asks the gate", async () => {
    const result = await fetchUrlTool.execute(
      { url: "https://example.com/" },
      makeContext(box.workspace, { mode: "auto-edit" }),
    );
    assert.match(result.output, /permission denied/);
  });
});

describe("fetch_url against a local server (private network explicitly allowed)", () => {
  let server;
  let base;
  const local = new FetchUrlTool({ allowPrivateNetwork: true, timeoutMs: 2000 });
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") {
        res.setHeader("content-type", "text/html");
        res.end(
          "<html><script>evil()</script><h1>Title</h1><p>Body &amp; more</p><pre>  code()\n    nested</pre></html>",
        );
      } else if (req.url?.startsWith("/loop")) {
        res.writeHead(302, { location: `/loop${Number(req.url.slice(5) || 0) + 1}` }).end();
      } else if (req.url === "/big") {
        res.setHeader("content-type", "text/plain");
        res.end("y".repeat(200_000));
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 5000);
      } else if (req.url === "/image") {
        res.setHeader("content-type", "image/png");
        res.end(Buffer.from([0x89, 0x50]));
      } else {
        res.writeHead(301, { location: "/page" }).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test("follows redirects and converts HTML, keeping code blocks", async () => {
    const result = await local.execute({ url: `${base}/start` }, makeContext(box.workspace));
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /HTTP 200/);
    assert.match(result.output, /Title\nBody & more/);
    assert.match(result.output, /```\n {2}code\(\)\n {4}nested\n```/);
    assert.doesNotMatch(result.output, /evil/);
  });

  test("stops after 5 redirects, caps text, refuses binaries and times out", async () => {
    const ctx = makeContext(box.workspace);
    assert.match((await local.execute({ url: `${base}/loop` }, ctx)).output, /too many redirects/);
    const big = await local.execute({ url: `${base}/big` }, ctx);
    assert.ok(big.output.length < 52 * 1024);
    assert.match(big.output, /body truncated/);
    assert.match((await local.execute({ url: `${base}/image` }, ctx)).output, /non-text content/);
    assert.match(
      (await local.execute({ url: `${base}/slow` }, ctx)).output,
      /timed out after 2000 ms/,
    );
  });

  test("htmlToText decodes entities and collapses blank lines", () => {
    assert.equal(htmlToText("<p>a&lt;b</p>\n\n\n<p>c</p>"), "a<b\n\nc");
  });
});
