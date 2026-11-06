import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { isBlockedAddress, isBlockedHostname, safeLookup } from "../../../dist/security/network.js";
import {
  assertNoDeviceName,
  DefaultPathGuard,
  isInsidePath,
  PathGuardError,
} from "../../../dist/security/paths.js";
import { autoAllowed, DefaultPermissionGate } from "../../../dist/security/permissions.js";
import { redactSecrets } from "../../../dist/security/redact.js";
import { FAKE_KEY, fakeHandler, makeSandbox } from "./helpers.mjs";

describe("path guard", () => {
  let box;
  let guard;
  before(async () => {
    box = await makeSandbox();
    guard = new DefaultPathGuard({ cwd: box.workspace });
    await writeFile(join(box.workspace, "a.txt"), "hi");
    await writeFile(join(box.outside, "secret.txt"), "nope");
  });
  after(() => box.cleanup());

  test("resolves files inside the workspace", async () => {
    const resolved = await guard.resolveForRead("a.txt");
    assert.equal(resolved.inside, true);
    assert.equal(resolved.exists, true);
    assert.equal(resolved.type, "file");
    assert.equal(guard.relative(resolved.abs), "a.txt");
    const missing = await guard.resolveForWrite("new/dir/file.txt");
    assert.equal(missing.exists, false);
    assert.equal(missing.type, "missing");
  });

  test("flags traversal on read and rejects it on write", async () => {
    const read = await guard.resolveForRead("../outside/secret.txt");
    assert.equal(read.inside, false);
    await assert.rejects(guard.resolveForWrite("../outside/x.txt"), PathGuardError);
    await assert.rejects(
      guard.resolveForWrite(join(box.outside, "x.txt")),
      /outside the workspace/,
    );
  });

  test("rejects device names, NUL bytes and empty paths", async () => {
    for (const name of ["CON", "nul.txt", "sub/COM1", "lpt9.log", "aux:stream"]) {
      await assert.rejects(guard.resolveForRead(name), /reserved device name/, name);
    }
    assert.doesNotThrow(() => assertNoDeviceName("console.ts"));
    assert.doesNotThrow(() => assertNoDeviceName("src/com10.txt"));
    await assert.rejects(guard.resolveForRead("a\u0000b"), /NUL byte/);
    await assert.rejects(guard.resolveForRead("  "), /non-empty/);
  });

  test("containment uses a trailing separator guard", () => {
    assert.equal(isInsidePath("C:\\foobar", "C:\\foo", true), false);
    const root = join("/srv/foo");
    assert.equal(isInsidePath(join("/srv/foobar"), root, false), false);
    assert.equal(isInsidePath(join(root, "bar"), root, false), true);
    assert.equal(isInsidePath(`${root}/`, root, false), true);
    assert.equal(isInsidePath(join("/SRV/foo"), root, false), false);
    assert.equal(isInsidePath("C:\\FOO\\x", "c:\\foo", true), process.platform === "win32");
    assert.equal(guard.isInside(join(box.workspace, "x")), true);
    assert.equal(guard.isInside(`${box.workspace}bar`), false);
  });

  test("symlink or junction escaping the workspace is detected", async () => {
    await symlink(box.outside, join(box.workspace, "escape"), "junction");
    const read = await guard.resolveForRead("escape/secret.txt");
    assert.equal(read.inside, false);
    await assert.rejects(guard.resolveForWrite("escape/new.txt"), /outside the workspace/);
  });

  test("dangling link pointing outside cannot be written through", async () => {
    await symlink(join(box.outside, "not-yet"), join(box.workspace, "dangling"), "junction");
    await assert.rejects(guard.resolveForWrite("dangling/file.txt"), /outside the workspace/);
  });

  test("links that stay inside the workspace are allowed", async () => {
    await mkdir(join(box.workspace, "real"));
    await symlink(join(box.workspace, "real"), join(box.workspace, "alias"), "junction");
    const resolved = await guard.resolveForWrite("alias/file.txt");
    assert.equal(resolved.inside, true);
  });
});

describe("permission gate", () => {
  const write = { tool: "write_file", action: "write", title: "Edit a", resource: "/w/a" };
  const shell = { tool: "run_command", action: "shell", title: "Run ls", resource: "ls" };
  const network = { tool: "fetch_url", action: "network", title: "Fetch", resource: "https://x" };
  const outside = {
    tool: "read_file",
    action: "outside-workspace",
    title: "Read /etc",
    resource: "/etc/hosts",
    insideWorkspace: false,
  };

  test("mode matrix", () => {
    const cases = [
      ["ask", write, false],
      ["ask", shell, false],
      ["ask", network, false],
      ["auto-edit", write, true],
      ["auto-edit", shell, false],
      ["auto-edit", network, false],
      ["full-auto", write, true],
      ["full-auto", shell, true],
      ["full-auto", network, true],
      ["full-auto", outside, false],
      ["auto-edit", { ...write, insideWorkspace: false }, false],
    ];
    for (const [mode, request, expected] of cases) {
      assert.equal(autoAllowed(mode, request), expected, `${mode} ${request.action}`);
    }
  });

  test("non-interactive sessions deny with an actionable reason and never hang", async () => {
    const gate = new DefaultPermissionGate({ mode: "ask" });
    const shellDecision = await gate.ensure(shell);
    assert.equal(shellDecision.allowed, false);
    assert.match(shellDecision.reason, /--permission-mode full-auto or --yolo/);
    assert.match((await gate.ensure(write)).reason, /--permission-mode auto-edit/);
    const yolo = new DefaultPermissionGate({ mode: "full-auto" });
    assert.match((await yolo.ensure(outside)).reason, /outside the workspace always need/);
  });

  test("interactive decisions: allow, deny, allow-session memory", async () => {
    const deny = new DefaultPermissionGate({
      mode: "ask",
      handler: fakeHandler("deny"),
      interactive: true,
    });
    const denied = await deny.ensure(shell);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /user denied shell for ls/);

    const handler = fakeHandler("allow-session");
    const gate = new DefaultPermissionGate({ mode: "ask", handler, interactive: true });
    assert.equal((await gate.ensure(shell)).allowed, true);
    assert.equal((await gate.ensure(shell)).allowed, true);
    assert.equal(handler.requests.length, 1);
    assert.equal(gate.isAllowedForSession(shell), true);
    await gate.ensure({ ...shell, resource: "rm -rf x" });
    assert.equal(handler.requests.length, 2);
    gate.clearSession();
    assert.equal(gate.isAllowedForSession(shell), false);
  });

  test("concurrent prompts are serialized and reuse a session grant", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const handler = {
      async request() {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return "allow-session";
      },
    };
    const gate = new DefaultPermissionGate({ mode: "ask", handler, interactive: true });
    const results = await Promise.all([gate.ensure(shell), gate.ensure(shell), gate.ensure(shell)]);
    assert.ok(results.every((result) => result.allowed));
    assert.equal(peak, 1);
    assert.equal(calls, 1);
  });

  test("handler failure and pre-aborted signal deny", async () => {
    const broken = { request: async () => Promise.reject(new Error("tty closed")) };
    const gate = new DefaultPermissionGate({ mode: "ask", handler: broken, interactive: true });
    assert.match((await gate.ensure(shell)).reason, /approval handler failed: tty closed/);
    const controller = new AbortController();
    controller.abort();
    const ok = new DefaultPermissionGate({
      mode: "ask",
      handler: fakeHandler(),
      interactive: true,
    });
    assert.equal((await ok.ensure(shell, controller.signal)).allowed, false);
  });
});

describe("redaction", () => {
  test("masks every known credential shape", () => {
    const samples = [
      [FAKE_KEY, "sk-or-***"],
      ["github_pat_ABCDEFGHIJ0123456789", "github_pat_***"],
      ["ghp_ABCDEFGHIJKLMNOP1234", "gh*_***"],
      ["gho_ABCDEFGHIJKLMNOP1234", "gh*_***"],
      ["ghs_ABCDEFGHIJKLMNOP1234", "gh*_***"],
      ["xoxb-1234567890-abcdef", "xox*-***"],
      ["AKIAABCDEFGHIJKLMNOP", "AKIA***"],
    ];
    for (const [secret, mask] of samples) {
      const output = redactSecrets(`token=${secret} end`);
      assert.equal(output, `token=${mask} end`, secret);
    }
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    assert.doesNotMatch(redactSecrets(`x\n${pem}\ny`), /MIIabc/);
  });

  test("masks caller-supplied secrets and leaves clean text untouched", () => {
    assert.equal(redactSecrets("key is hunter2hunter2!", ["hunter2hunter2"]), "key is ***!");
    assert.equal(redactSecrets("short abc", ["abc"]), "short abc");
    const clean = "nothing secret here";
    assert.equal(redactSecrets(clean), clean);
    assert.equal(redactSecrets(""), "");
  });
});

describe("network guard", () => {
  test("blocks loopback, private, link-local, metadata and mapped addresses", () => {
    const blocked = [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "[::1]",
    ];
    for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);
    for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "1.1.1.1"]) {
      assert.equal(isBlockedAddress(address), false, address);
    }
    assert.equal(isBlockedHostname("localhost"), true);
    assert.equal(isBlockedHostname("api.localhost"), true);
    assert.equal(isBlockedHostname("metadata.google.internal"), true);
    assert.equal(isBlockedHostname("example.com"), false);
  });

  test("safeLookup refuses names that resolve to private addresses", async () => {
    const error = await new Promise((resolve) =>
      safeLookup("localhost", {}, (err) => resolve(err)),
    );
    assert.ok(error);
    assert.equal(error.code, "EBLOCKEDADDRESS");
  });
});
