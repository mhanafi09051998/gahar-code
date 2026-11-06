import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { projectFolderName, projectHash, projectSlug } from "../../../dist/config/paths.js";
import { clearGlobalApiKey, loadConfig, saveGlobalConfig } from "../../../dist/config/store.js";

const roots = [];
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function setup({ global, project } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gahar-config-"));
  roots.push(root);
  const configDir = join(root, "home");
  const cwd = join(root, "proj");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(cwd, ".gahar"), { recursive: true });
  if (global !== undefined) await writeFile(join(configDir, "config.json"), global);
  if (project !== undefined) await writeFile(join(cwd, ".gahar", "config.json"), project);
  return { configDir, cwd };
}

test("defaults apply when no config exists", async () => {
  const { configDir, cwd } = await setup();
  const { config, projectPath } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(config.model, "anthropic/claude-sonnet-4.6");
  assert.equal(config.permissionMode, "ask");
  assert.equal(config.apiKeySource, "none");
  assert.equal(config.apiKey, null);
  assert.equal(config.configDir, configDir);
  assert.equal(projectPath, null);
  assert.deepEqual(config.warnings, []);
});

test("precedence is CLI > env > project > global > defaults", async () => {
  const { configDir, cwd } = await setup({
    global: JSON.stringify({ model: "g/model", maxTokens: 100, permissionMode: "full-auto" }),
    project: JSON.stringify({ model: "p/model", maxTokens: 200 }),
  });
  const env = { GAHAR_CONFIG_DIR: configDir, GAHAR_MODEL: "e/model" };
  const base = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(base.config.model, "p/model");
  assert.equal(base.config.maxTokens, 200);
  assert.equal(base.config.permissionMode, "full-auto");
  const withEnv = await loadConfig({ cwd, env });
  assert.equal(withEnv.config.model, "e/model");
  const withCli = await loadConfig({
    cwd,
    env,
    overrides: { model: "c/model", permissionMode: "auto-edit" },
  });
  assert.equal(withCli.config.model, "c/model");
  assert.equal(withCli.config.permissionMode, "auto-edit");
});

test("env flags: key, base url, debug, update check, NO_COLOR, invalid mode", async () => {
  const { configDir, cwd } = await setup({
    global: JSON.stringify({ apiKey: "sk-or-v1-test-global" }),
  });
  const { config } = await loadConfig({
    cwd,
    env: {
      GAHAR_CONFIG_DIR: configDir,
      OPENROUTER_API_KEY: "sk-or-v1-test-env",
      GAHAR_BASE_URL: "http://127.0.0.1:9/api",
      GAHAR_DEBUG: "1",
      GAHAR_NO_UPDATE_CHECK: "true",
      NO_COLOR: "1",
      GAHAR_PERMISSION_MODE: "yolo",
    },
  });
  assert.equal(config.apiKey, "sk-or-v1-test-env");
  assert.equal(config.apiKeySource, "env");
  assert.equal(config.baseUrl, "http://127.0.0.1:9/api");
  assert.equal(config.debug, true);
  assert.equal(config.updateCheck, false);
  assert.equal(config.noColor, true);
  assert.equal(config.permissionMode, "ask");
  assert.ok(config.warnings.some((w) => w.includes("GAHAR_PERMISSION_MODE")));
});

test("global apiKey is used when env is absent", async () => {
  const { configDir, cwd } = await setup({
    global: JSON.stringify({ apiKey: "sk-or-v1-test-global" }),
  });
  const { config, globalConfig } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(config.apiKey, "sk-or-v1-test-global");
  assert.equal(config.apiKeySource, "config");
  assert.equal(globalConfig.apiKey, "sk-or-v1-test-global");
});

test("project secrets and global-only fields are ignored with warnings", async () => {
  const { configDir, cwd } = await setup({
    project: JSON.stringify({
      apiKey: "sk-or-v1-test-evil",
      githubToken: "x",
      baseUrl: "http://evil.invalid",
      model: "p/m",
    }),
  });
  const { config, projectConfig } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(config.apiKey, null);
  assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.model, "p/m");
  assert.equal(projectConfig.apiKey, undefined);
  assert.ok(config.warnings.some((w) => w.includes('"apiKey"') && w.includes("project")));
  assert.ok(config.warnings.some((w) => w.includes('"githubToken"')));
  assert.ok(config.warnings.some((w) => w.includes('"baseUrl"')));
});

test("project config cannot loosen permissionMode but may tighten it", async () => {
  for (const mode of ["full-auto", "auto-edit"]) {
    const { configDir, cwd } = await setup({ project: JSON.stringify({ permissionMode: mode }) });
    const { config } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
    assert.equal(config.permissionMode, "ask");
    assert.ok(config.warnings.some((w) => w.includes("permissionMode") && w.includes(mode)));
  }
  const { configDir, cwd } = await setup({
    global: JSON.stringify({ permissionMode: "full-auto" }),
    project: JSON.stringify({ permissionMode: "ask" }),
  });
  const { config } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(config.permissionMode, "ask");
  assert.deepEqual(config.warnings, []);
});

test("global updateCheck and baseUrl are honored without warnings", async () => {
  const { configDir, cwd } = await setup({
    global: JSON.stringify({ version: 1, updateCheck: false, baseUrl: "http://127.0.0.1:1/v1" }),
  });
  const { config } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(config.updateCheck, false);
  assert.equal(config.baseUrl, "http://127.0.0.1:1/v1");
  assert.deepEqual(config.warnings, []);
});

test("corrupt global config is backed up and defaults are used", async () => {
  const { configDir, cwd } = await setup({ global: "{ not json", project: "[1,2" });
  const { config } = await loadConfig({ cwd, env: { GAHAR_CONFIG_DIR: configDir } });
  assert.equal(config.model, "anthropic/claude-sonnet-4.6");
  assert.equal(await readFile(join(configDir, "config.json.bak"), "utf8"), "{ not json");
  assert.ok(config.warnings.some((w) => w.includes("config.json.bak")));
  assert.ok(config.warnings.some((w) => w.includes("Project config")));
});

test("saveGlobalConfig merges and clearGlobalApiKey strips the key", async () => {
  const { configDir } = await setup({ global: JSON.stringify({ model: "keep/me" }) });
  const path = await saveGlobalConfig(configDir, { apiKey: "sk-or-v1-test-save" });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved, { model: "keep/me", apiKey: "sk-or-v1-test-save", version: 1 });
  assert.equal(await clearGlobalApiKey(configDir), true);
  assert.equal(await clearGlobalApiKey(configDir), false);
  const cleared = JSON.parse(await readFile(path, "utf8"));
  assert.equal(cleared.apiKey, undefined);
  assert.equal(cleared.model, "keep/me");
});

test("project folder names are slug plus 8 char hash", () => {
  const abs = join(tmpdir(), "My Project!");
  assert.equal(projectSlug(abs), "my-project");
  assert.match(projectHash(abs), /^[0-9a-f]{8}$/);
  assert.equal(projectFolderName(abs), `my-project-${projectHash(abs)}`);
  assert.equal(projectSlug("/"), "project");
});
