import type { LoadedConfig } from "../contracts/config.js";
import type { KeyInfo } from "../contracts/messages.js";
import type { CliEnv } from "./env.js";
import { createQuestioner, type Questioner } from "./questioner.js";

export interface AuthDeps {
  env: CliEnv;
  loaded: LoadedConfig;
  client: {
    validateKey(key?: string): Promise<KeyInfo>;
  };
  readKey?: () => Promise<string | null>;
  saveKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
  questioner?: Questioner;
}

export interface AuthIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "****";
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

export function authStatusLines(loaded: LoadedConfig, key: string | null, info?: KeyInfo): string[] {
  const source = loaded.config.apiKeySource;
  const lines = [`source: ${source}`];
  if (key === null || key === "") {
    lines.push("key:    not configured", "Run: gahar auth login");
  } else {
    lines.push(`key:    ${maskKey(key)}`);
  }
  if (info !== undefined) {
    lines.push(`label:  ${info.label ?? "n/a"}`);
    lines.push(
      `usage:  ${formatNumber(info.usage)} of ${info.limit === null || info.limit === undefined ? "unlimited" : formatNumber(info.limit)}`,
    );
    lines.push(
      `free:   ${info.is_free_tier === true ? "yes" : "no"}`,
    );
  }
  return lines;
}

export async function runAuth(
  action: string | undefined,
  deps: AuthDeps,
  io: AuthIO,
): Promise<number> {
  if (action === undefined || action === "" || action === "status") return authStatus(deps, io);
  if (action === "login") return authLogin(deps, io);
  if (action === "logout") return authLogout(deps, io);
  io.stderr(`unknown auth action: ${action} (expected login, status or logout)`);
  return 2;
}

async function authStatus(deps: AuthDeps, io: AuthIO): Promise<number> {
  const key = deps.loaded.config.apiKey;
  let info: KeyInfo | undefined;
  if (key !== null && key !== "") {
    try {
      info = await deps.client.validateKey(key);
    } catch {
      io.stderr("warning: could not reach OpenRouter to validate the key");
    }
  }
  for (const line of authStatusLines(deps.loaded, key, info)) io.stdout(line);
  return key === null || key === "" ? 3 : 0;
}

async function authLogin(deps: AuthDeps, io: AuthIO): Promise<number> {
  const existing = deps.readKey !== undefined ? await deps.readKey() : deps.loaded.config.apiKey;
  if (existing !== null && existing !== undefined && existing !== "") {
    io.stdout(`using existing key ${maskKey(existing)}`);
    try {
      await deps.client.validateKey(existing);
      await deps.saveKey(existing);
      io.stdout("key is valid and saved");
      return 0;
    } catch (error) {
      io.stderr(`existing key rejected: ${describe(error)}`);
      io.stdout("provide a new key to continue");
    }
  }
  const questioner =
    deps.questioner ??
    createQuestioner({ stderr: deps.env.stderr, interactive: deps.env.stdinIsTTY });
  const answer = (await questioner.hidden("OpenRouter API key (input hidden): ")).trim();
  if (answer === "") {
    io.stderr("no key provided; aborting");
    return 3;
  }
  try {
    const info = await deps.client.validateKey(answer);
    await deps.saveKey(answer);
    io.stdout(`key validated and saved (${maskKey(answer)})`);
    if (info.limit_remaining !== null && info.limit_remaining !== undefined) {
      io.stdout(`remaining credit: ${formatNumber(info.limit_remaining)}`);
    }
    return 0;
  } catch (error) {
    io.stderr(`key validation failed: ${describe(error)}`);
    return 3;
  }
}

async function authLogout(deps: AuthDeps, io: AuthIO): Promise<number> {
  await deps.clearKey();
  io.stdout("removed the stored API key");
  if (deps.env.env.OPENROUTER_API_KEY !== undefined && deps.env.env.OPENROUTER_API_KEY !== "") {
    io.stderr("note: OPENROUTER_API_KEY is still set in the environment");
  }
  return 0;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return `${value.toFixed(2)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
