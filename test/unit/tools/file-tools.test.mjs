import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { editFileTool } from "../../../dist/tools/edit_file.js";
import { multiEditTool } from "../../../dist/tools/multi_edit.js";
import { readFileTool } from "../../../dist/tools/read_file.js";
import { writeFileTool } from "../../../dist/tools/write_file.js";
import { fakeHandler, makeContext, makeSandbox } from "./helpers.mjs";

let box;
before(async () => {
  box = await makeSandbox();
});
after(() => box.cleanup());

describe("read_file", () => {
  test("returns numbered lines, honours offset/limit and records the read", async () => {
    const ctx = makeContext(box.workspace);
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(join(box.workspace, "lines.txt"), lines);
    const result = await readFileTool.execute({ path: "lines.txt", offset: 3, limit: 2 }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.output, /^ {4}3\|line 3\n {4}4\|line 4/);
    assert.match(result.output, /6 more lines; continue with offset=5/);
    await ctx.files.assertFresh(join(box.workspace, "lines.txt"));
  });

  test("caps very long lines and refuses binaries and directories", async () => {
    const ctx = makeContext(box.workspace);
    await writeFile(join(box.workspace, "long.txt"), "x".repeat(5000));
    const long = await readFileTool.execute({ path: "long.txt" }, ctx);
    assert.ok(long.output.length < 2100);
    await writeFile(join(box.workspace, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    const binary = await readFileTool.execute({ path: "bin.dat" }, ctx);
    assert.equal(binary.ok, false);
    assert.match(binary.output, /binary/);
    assert.match((await readFileTool.execute({ path: "." }, ctx)).output, /is a directory/);
    assert.match((await readFileTool.execute({ path: "nope.txt" }, ctx)).output, /not found/);
  });

  test("invalid arguments return a message instead of throwing", async () => {
    const ctx = makeContext(box.workspace);
    for (const args of [null, [], {}, { path: 3 }, { path: "a", offset: "x" }]) {
      const result = await readFileTool.execute(args, ctx);
      assert.equal(result.ok, false);
      assert.match(result.output, /invalid arguments/);
    }
  });

  test("reading outside the workspace needs approval", async () => {
    await writeFile(join(box.outside, "secret.txt"), "classified");
    const denied = await readFileTool.execute(
      { path: "../outside/secret.txt" },
      makeContext(box.workspace),
    );
    assert.equal(denied.ok, false);
    assert.match(denied.output, /permission denied/);
    const handler = fakeHandler("allow");
    const allowed = await readFileTool.execute(
      { path: "../outside/secret.txt" },
      makeContext(box.workspace, { mode: "ask", handler }),
    );
    assert.equal(allowed.ok, true);
    assert.equal(handler.requests[0].action, "outside-workspace");
  });
});

describe("write_file", () => {
  test("creates new files (with parents) and snapshots them for undo", async () => {
    const ctx = makeContext(box.workspace);
    const result = await writeFileTool.execute({ path: "deep/new.txt", content: "hello" }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.output, /Created deep\/new\.txt \(5 B\)/);
    assert.equal(await readFile(join(box.workspace, "deep/new.txt"), "utf8"), "hello");
    assert.deepEqual(ctx.snapshots.captured, [join(box.workspace, "deep", "new.txt")]);
  });

  test("overwriting requires a fresh read", async () => {
    const ctx = makeContext(box.workspace);
    await writeFile(join(box.workspace, "exist.txt"), "v1");
    const blind = await writeFileTool.execute({ path: "exist.txt", content: "v2" }, ctx);
    assert.equal(blind.ok, false);
    assert.match(blind.output, /has not been read/);
    await readFileTool.execute({ path: "exist.txt" }, ctx);
    await writeFile(join(box.workspace, "exist.txt"), "changed elsewhere");
    assert.match(
      (await writeFileTool.execute({ path: "exist.txt", content: "v2" }, ctx)).output,
      /changed on disk/,
    );
    await readFileTool.execute({ path: "exist.txt" }, ctx);
    const ok = await writeFileTool.execute({ path: "exist.txt", content: "v2" }, ctx);
    assert.equal(ok.ok, true);
    assert.equal(ok.detail, "update");
  });

  test("refuses to write outside the workspace and when the gate denies", async () => {
    const ctx = makeContext(box.workspace);
    const escaped = await writeFileTool.execute({ path: "../outside/x.txt", content: "x" }, ctx);
    assert.equal(escaped.ok, false);
    assert.match(escaped.output, /outside the workspace/);
    const askCtx = makeContext(box.workspace, { mode: "ask" });
    const denied = await writeFileTool.execute({ path: "gated.txt", content: "x" }, askCtx);
    assert.match(denied.output, /permission denied.*auto-edit/);
    assert.deepEqual(askCtx.snapshots.captured, []);
  });
});

describe("edit_file", () => {
  test("replaces a unique string and returns a diff", async () => {
    const ctx = makeContext(box.workspace);
    await writeFile(join(box.workspace, "e.txt"), "alpha\nbeta\ngamma\n");
    await readFileTool.execute({ path: "e.txt" }, ctx);
    const result = await editFileTool.execute(
      { path: "e.txt", old_string: "beta", new_string: "$& BETA" },
      ctx,
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /-beta\n\+\$& BETA/);
    assert.equal(await readFile(join(box.workspace, "e.txt"), "utf8"), "alpha\n$& BETA\ngamma\n");
    const again = await editFileTool.execute(
      { path: "e.txt", old_string: "gamma", new_string: "" },
      ctx,
    );
    assert.equal(again.ok, true, "edits chain without re-reading");
  });

  test("reports non-unique and missing matches without writing", async () => {
    const ctx = makeContext(box.workspace);
    await writeFile(join(box.workspace, "dup.txt"), "x x x");
    await readFileTool.execute({ path: "dup.txt" }, ctx);
    const dup = await editFileTool.execute(
      { path: "dup.txt", old_string: "x", new_string: "y" },
      ctx,
    );
    assert.equal(dup.ok, false);
    assert.match(dup.output, /matches 3 times/);
    const missing = await editFileTool.execute(
      { path: "dup.txt", old_string: "z", new_string: "y" },
      ctx,
    );
    assert.match(missing.output, /not found/);
    assert.equal(await readFile(join(box.workspace, "dup.txt"), "utf8"), "x x x");
    const all = await editFileTool.execute(
      { path: "dup.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx,
    );
    assert.match(all.output, /3 replacements/);
    assert.equal(await readFile(join(box.workspace, "dup.txt"), "utf8"), "y y y");
  });

  test("requires a prior read", async () => {
    await writeFile(join(box.workspace, "unread.txt"), "a");
    const result = await editFileTool.execute(
      { path: "unread.txt", old_string: "a", new_string: "b" },
      makeContext(box.workspace),
    );
    assert.match(result.output, /has not been read/);
  });
});

describe("multi_edit", () => {
  test("applies all edits atomically or none at all", async () => {
    const ctx = makeContext(box.workspace);
    const file = join(box.workspace, "m.txt");
    await writeFile(file, "one two three");
    await readFileTool.execute({ path: "m.txt" }, ctx);
    const bad = await multiEditTool.execute(
      {
        path: "m.txt",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "missing", new_string: "?" },
        ],
      },
      ctx,
    );
    assert.equal(bad.ok, false);
    assert.match(bad.output, /no changes were written: edit #2/);
    assert.equal(await readFile(file, "utf8"), "one two three");
    const overlap = await multiEditTool.execute(
      {
        path: "m.txt",
        edits: [
          { old_string: "one two", new_string: "x" },
          { old_string: "two three", new_string: "y" },
        ],
      },
      ctx,
    );
    assert.match(overlap.output, /overlap/);
    const good = await multiEditTool.execute(
      {
        path: "m.txt",
        edits: [
          { old_string: "three", new_string: "3" },
          { old_string: "one", new_string: "1" },
        ],
      },
      ctx,
    );
    assert.equal(good.ok, true);
    assert.equal(await readFile(file, "utf8"), "1 two 3");
    assert.equal(ctx.snapshots.captured.length, 1);
  });
});

describe("CRLF files", () => {
  test("multi-line edits copied from read_file match and keep CRLF endings", async () => {
    const ctx = makeContext(box.workspace);
    const file = join(box.workspace, "crlf.txt");
    await writeFile(file, "a\r\nb\r\nc\r\n");
    await readFileTool.execute({ path: "crlf.txt" }, ctx);
    const edit = { path: "crlf.txt", old_string: "a\nb", new_string: "x\ny\nz" };
    assert.equal((await editFileTool.execute(edit, ctx)).ok, true);
    assert.equal(await readFile(file, "utf8"), "x\r\ny\r\nz\r\nc\r\n");
    const multi = { path: "crlf.txt", edits: [{ old_string: "z\nc", new_string: "w" }] };
    assert.equal((await multiEditTool.execute(multi, ctx)).ok, true);
    assert.equal(await readFile(file, "utf8"), "x\r\ny\r\nw\r\n");
  });
});
