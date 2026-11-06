import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { globTool } from "../../../dist/tools/glob.js";
import { grepTool } from "../../../dist/tools/grep.js";
import { listDirTool } from "../../../dist/tools/list_dir.js";
import { builtinTools, createDefaultRegistry } from "../../../dist/tools/registry.js";
import { todoWriteTool } from "../../../dist/tools/todo_write.js";
import { makeContext, makeSandbox } from "./helpers.mjs";

let box;
let ctx;
before(async () => {
  box = await makeSandbox();
  ctx = makeContext(box.workspace);
  await mkdir(join(box.workspace, "src", "deep"), { recursive: true });
  await mkdir(join(box.workspace, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(box.workspace, "src", "a.ts"), "export const Alpha = 1;\n");
  await writeFile(join(box.workspace, "src", "deep", "b.ts"), "const alpha = 2;\n");
  await writeFile(join(box.workspace, "node_modules", "pkg", "c.ts"), "alpha");
  await writeFile(join(box.workspace, "bin.dat"), Buffer.from([0x61, 0x6c, 0, 0x70]));
});
after(() => box.cleanup());

describe("list_dir", () => {
  test("lists one level by default and skips node_modules", async () => {
    const result = await listDirTool.execute({}, ctx);
    assert.equal(result.ok, true);
    assert.match(result.output, /src\//);
    assert.doesNotMatch(result.output, /node_modules|a\.ts/);
    const deep = await listDirTool.execute({ path: "src", depth: 9 }, ctx);
    assert.match(deep.output, /deep\/b\.ts/);
  });

  test("caps entries at 500", async () => {
    const many = join(box.workspace, "many");
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 520 }, (_, i) => writeFile(join(many, `f${i}.txt`), "")),
    );
    const result = await listDirTool.execute({ path: "many" }, ctx);
    assert.match(result.output, /capped at 500 entries/);
  });

  test("rejects files and outside paths", async () => {
    assert.match((await listDirTool.execute({ path: "src/a.ts" }, ctx)).output, /not a directory/);
    const outside = await listDirTool.execute({ path: "../outside" }, makeContext(box.workspace));
    assert.match(outside.output, /permission denied/);
  });
});

describe("glob", () => {
  test("matches files, skips node_modules unless asked", async () => {
    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    assert.equal(result.output.split("\n").sort().join(","), "src/a.ts,src/deep/b.ts");
    const modules = await globTool.execute({ pattern: "node_modules/**/*.ts" }, ctx);
    assert.match(modules.output, /node_modules\/pkg\/c\.ts/);
    assert.match((await globTool.execute({ pattern: "*.none" }, ctx)).output, /No files matched/);
  });

  test("refuses patterns that climb out of the workspace", async () => {
    for (const pattern of ["../**", "/etc/*", "src/../../x", "C:/Windows/*"]) {
      const result = await globTool.execute({ pattern }, ctx);
      assert.equal(result.ok, false, pattern);
      assert.match(result.output, /must be relative/);
    }
  });

  test("caps results at 200", async () => {
    const result = await globTool.execute({ pattern: "many/*.txt" }, ctx);
    assert.match(result.output, /320 more matches/);
  });
});

describe("grep", () => {
  test("finds matches with file:line: text and honours ignore_case", async () => {
    const sensitive = await grepTool.execute({ pattern: "alpha", include: "**/*.ts" }, ctx);
    assert.equal(sensitive.output, "src/deep/b.ts:1: const alpha = 2;");
    const insensitive = await grepTool.execute({ pattern: "alpha", ignore_case: true }, ctx);
    assert.match(insensitive.output, /src\/a\.ts:1: export const Alpha/);
    assert.doesNotMatch(insensitive.output, /node_modules|bin\.dat/);
  });

  test("reports invalid regex and caps at 250 matches", async () => {
    const bad = await grepTool.execute({ pattern: "(" }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /invalid regular expression/);
    await writeFile(join(box.workspace, "big.txt"), "hit\n".repeat(400));
    const capped = await grepTool.execute({ pattern: "hit", include: "big.txt" }, ctx);
    assert.match(capped.output, /capped at 250 matches/);
    assert.match(
      (await grepTool.execute({ pattern: "x", include: "../*" }, ctx)).output,
      /relative/,
    );
  });
});

describe("todo_write", () => {
  test("stores a validated list", async () => {
    const local = makeContext(box.workspace);
    const result = await todoWriteTool.execute(
      {
        todos: [
          { content: " plan ", status: "completed" },
          { content: "build", status: "in_progress" },
        ],
      },
      local,
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /1\. \[x\] plan\n2\. \[>\] build/);
    assert.deepEqual(local.todos.list(), [
      { content: "plan", status: "completed" },
      { content: "build", status: "in_progress" },
    ]);
  });

  test("rejects bad items without touching the store", async () => {
    const local = makeContext(box.workspace);
    for (const todos of [
      undefined,
      "x",
      [{ content: "", status: "pending" }],
      [{ content: "a", status: "done" }],
      [3],
    ]) {
      const result = await todoWriteTool.execute({ todos }, local);
      assert.equal(result.ok, false);
      assert.match(result.output, /invalid arguments/);
    }
    assert.deepEqual(local.todos.list(), []);
  });
});

describe("registry", () => {
  test("exposes every tool with stable definitions", () => {
    const registry = createDefaultRegistry();
    const names = registry.definitions().map((definition) => definition.function.name);
    assert.deepEqual(
      names,
      builtinTools.map((tool) => tool.name),
    );
    assert.ok(names.includes("run_command") && names.includes("fetch_url"));
    assert.equal(registry.get("read_file")?.readOnly, true);
    assert.equal(registry.get("fetch_url")?.readOnly, false);
    assert.equal(registry.get("nope"), undefined);
    for (const definition of registry.definitions()) {
      assert.equal(definition.type, "function");
      assert.equal(definition.function.parameters.type, "object");
    }
    assert.throws(() => createDefaultRegistry([builtinTools[0], builtinTools[0]]), /duplicate/);
  });
});
