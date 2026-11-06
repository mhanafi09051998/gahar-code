import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { UndoManager } from "../../../dist/session/undo.js";

const roots = [];
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "gahar-undo-"));
  roots.push(root);
  const cwd = join(root, "proj");
  const snapshotsDir = join(root, "snapshots");
  await mkdir(join(cwd, "src"), { recursive: true });
  return { cwd, snapshotsDir };
}

const exists = (path) =>
  readFile(path).then(
    () => true,
    () => false,
  );

test("restoreTurn restores edited files and deletes created ones", async () => {
  const { cwd, snapshotsDir } = await setup();
  const edited = join(cwd, "src", "a.txt");
  const created = join(cwd, "new.txt");
  const binary = join(cwd, "index.json");
  await writeFile(edited, "original");
  await writeFile(binary, Buffer.from([0, 1, 2, 255, 254]));
  const undo = new UndoManager({ snapshotsDir, cwd });
  assert.equal(await undo.beginTurn(), 1);
  await undo.capture(edited);
  await undo.capture(created);
  await undo.capture(binary);
  await writeFile(edited, "changed");
  await undo.capture(edited);
  await writeFile(edited, "changed twice");
  await writeFile(created, "brand new");
  await writeFile(binary, "overwritten");

  const result = await undo.undoLast();
  assert.equal(result.turn, 1);
  assert.equal(result.restored.length, 3);
  assert.equal(await readFile(edited, "utf8"), "original");
  assert.equal(await exists(created), false);
  assert.deepEqual([...(await readFile(binary))], [0, 1, 2, 255, 254]);
  assert.equal(await undo.undoLast(), null);
});

test("turn numbers continue after a resume instead of colliding", async () => {
  const { cwd, snapshotsDir } = await setup();
  const file = join(cwd, "f.txt");
  await writeFile(file, "v1");
  const first = new UndoManager({ snapshotsDir, cwd });
  await first.capture(file);
  assert.equal(first.turn, 1);
  await writeFile(file, "v2");

  const resumed = new UndoManager({ snapshotsDir, cwd });
  assert.equal(await resumed.beginTurn(), 2);
  await resumed.capture(file);
  await writeFile(file, "v3");
  assert.deepEqual(await resumed.listTurns(), [2, 1]);
  await resumed.undoLast();
  assert.equal(await readFile(file, "utf8"), "v2");
  await resumed.undoLast();
  assert.equal(await readFile(file, "utf8"), "v1");
});

test("only the newest maxTurns turns are kept", async () => {
  const { cwd, snapshotsDir } = await setup();
  const file = join(cwd, "f.txt");
  await writeFile(file, "x");
  const undo = new UndoManager({ snapshotsDir, cwd, maxTurns: 3 });
  for (let i = 0; i < 5; i++) {
    await undo.beginTurn();
    await undo.capture(file);
  }
  assert.deepEqual(await undo.listTurns(), [5, 4, 3]);
});

test("undo replaces a link instead of writing through it", async () => {
  const { symlink } = await import("node:fs/promises");
  const { cwd, snapshotsDir } = await setup();
  const target = join(cwd, "src", "config.sh");
  const outside = join(cwd, "..", "bashrc");
  await writeFile(target, "repo version");
  await writeFile(outside, "user rc");
  const undo = new UndoManager({ snapshotsDir, cwd });
  await undo.beginTurn();
  await undo.capture(target);
  await rm(target);
  try {
    await symlink(outside, target, "file");
  } catch {
    return; // Symlinks need extra privileges on some Windows setups.
  }
  const result = await undo.undoLast();
  assert.deepEqual(result.skipped, []);
  assert.equal(await readFile(outside, "utf8"), "user rc");
  assert.equal(await readFile(target, "utf8"), "repo version");
});

test("undo skips entries whose parent now escapes the workspace", async () => {
  const { symlink } = await import("node:fs/promises");
  const { cwd, snapshotsDir } = await setup();
  const outsideDir = join(cwd, "..", "elsewhere");
  await mkdir(outsideDir);
  await writeFile(join(cwd, "src", "a.txt"), "original");
  const undo = new UndoManager({ snapshotsDir, cwd });
  await undo.beginTurn();
  await undo.capture(join(cwd, "src", "a.txt"));
  await rm(join(cwd, "src"), { recursive: true });
  try {
    await symlink(outsideDir, join(cwd, "src"), "junction");
  } catch {
    return;
  }
  const result = await undo.undoLast();
  assert.deepEqual(result.restored, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(await exists(join(outsideDir, "a.txt")), false);
});
