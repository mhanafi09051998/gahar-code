import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultPathGuard } from "../../../dist/security/paths.js";
import { DefaultPermissionGate } from "../../../dist/security/permissions.js";
import { DefaultFileRegistry, MemoryTodoStore } from "../../../dist/tools/stores.js";

export const FAKE_KEY = "sk-or-v1-test0000000000000000";

/** Creates a temp directory holding a workspace folder plus a sibling "outside" folder. */
export async function makeSandbox() {
  const base = await mkdtemp(join(tmpdir(), "gahar-tools-"));
  await mkdir(join(base, "work"));
  await mkdir(join(base, "outside"));
  return {
    base,
    workspace: join(base, "work"),
    outside: join(base, "outside"),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** A recording approval handler that answers with a fixed decision. */
export function fakeHandler(decision = "allow") {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      return decision;
    },
  };
}

export function makeContext(workspace, options = {}) {
  const captured = [];
  const permissions =
    options.permissions ??
    new DefaultPermissionGate({
      mode: options.mode ?? "full-auto",
      handler: options.handler,
      interactive: options.handler !== undefined,
    });
  return {
    cwd: workspace,
    config: {
      apiKey: options.apiKey ?? null,
      configDir: options.configDir ?? join(workspace, "..", "global-config"),
    },
    signal: options.signal ?? new AbortController().signal,
    permissions,
    paths: new DefaultPathGuard({ cwd: workspace }),
    files: new DefaultFileRegistry(),
    snapshots: { captured, capture: async (abs) => void captured.push(abs) },
    todos: new MemoryTodoStore(),
    sessionId: "test-session",
    emit: () => undefined,
  };
}
