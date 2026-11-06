import { looksLikeApiKey, maskKey } from "../auth/key.js";
import type { LoadedConfig } from "../contracts/config.js";
import type { KeyInfo } from "../contracts/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { EXIT_ARG_ERROR, EXIT_AUTH_ERROR } from "./args.js";
import type { Questioner } from "./questioner.js";

export interface KeyClient {
  validateKey(key?: string): Promise<KeyInfo>;
}

export interface CommandIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface AuthDeps {
  loaded: LoadedConfig;
  client: KeyClient;
  questioner: Questioner;
  saveKey: (key: string) => Promise<void>;
  clearKey: () => Promise<boolean>;
  envKeySet: boolean;
}

export function formatDollars(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "n/a";
}

export function authStatusLines(loaded: LoadedConfig, info?: KeyInfo): string[] {
  const { apiKey, apiKeySource } = loaded.config;
  const lines = [`source: ${apiKeySource}`];
  if (apiKey === null || apiKey === "") {
    lines.push("key:    not configured", "Run: gahar auth login");
    return lines;
  }
  lines.push(`key:    ${maskKey(apiKey)}`);
  if (info !== undefined) {
    lines.push(`label:  ${info.label ?? "n/a"}`);
    const limit =
      info.limit === null || info.limit === undefined ? "unlimited" : formatDollars(info.limit);
    lines.push(`usage:  ${formatDollars(info.usage ?? 0)} of ${limit}`);
    lines.push(`free:   ${info.is_free_tier === true ? "yes" : "no"}`);
  }
  return lines;
}

export async function runAuth(
  action: string | undefined,
  deps: AuthDeps,
  io: CommandIO,
): Promise<number> {
  if (action === undefined || action === "status") return authStatus(deps, io);
  if (action === "login") return authLogin(deps, io);
  if (action === "logout") return authLogout(deps, io);
  io.err(`unknown auth action: ${action} (expected login, status or logout)`);
  return EXIT_ARG_ERROR;
}

async function authStatus(deps: AuthDeps, io: CommandIO): Promise<number> {
  const key = deps.loaded.config.apiKey;
  let info: KeyInfo | undefined;
  if (key !== null && key !== "") {
    try {
      info = await deps.client.validateKey(key);
    } catch (error) {
      io.err(`warning: could not validate the key: ${toErrorMessage(error)}`);
    }
  }
  for (const line of authStatusLines(deps.loaded, info)) io.out(line);
  return key === null || key === "" ? EXIT_AUTH_ERROR : 0;
}

/** Prompts for a key (hidden), validates it against /key and saves it. */
export async function promptAndSaveKey(
  deps: Pick<AuthDeps, "client" | "questioner" | "saveKey">,
  io: CommandIO,
): Promise<string | null> {
  const answer = (await deps.questioner.hidden("OpenRouter API key (input hidden): ")).trim();
  if (answer === "") {
    io.err("no key provided");
    return null;
  }
  if (!looksLikeApiKey(answer)) {
    io.err('that does not look like an OpenRouter key (expected "sk-or-...")');
    return null;
  }
  try {
    const info = await deps.client.validateKey(answer);
    await deps.saveKey(answer);
    io.out(`key validated and saved (${maskKey(answer)})`);
    if (typeof info.limit_remaining === "number") {
      io.out(`remaining credit: ${formatDollars(info.limit_remaining)}`);
    }
    return answer;
  } catch (error) {
    io.err(`key validation failed: ${toErrorMessage(error)}`);
    return null;
  }
}

async function authLogin(deps: AuthDeps, io: CommandIO): Promise<number> {
  return (await promptAndSaveKey(deps, io)) === null ? EXIT_AUTH_ERROR : 0;
}

async function authLogout(deps: AuthDeps, io: CommandIO): Promise<number> {
  const removed = await deps.clearKey();
  io.out(removed ? "removed the stored API key" : "no stored API key to remove");
  if (deps.envKeySet) io.err("note: OPENROUTER_API_KEY is still set in the environment");
  return 0;
}
