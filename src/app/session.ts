import type { ResolvedConfig } from "../contracts/config.js";
import type { ChatMessage, Usage } from "../contracts/messages.js";
import type { AppOptions } from "../contracts/runner.js";
import { latestSessionId, readSessionEvents, SessionStore } from "../session/index.js";
import { GaharError } from "../shared/errors.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface OpenedSession {
  store: SessionStore;
  history: ChatMessage[];
  usage: Usage;
}

export async function openSession(
  opts: AppOptions,
  model: string,
  notice: (message: string) => void,
): Promise<OpenedSession> {
  const { configDir } = opts.config;
  const fresh = async (): Promise<OpenedSession> => ({
    store: await SessionStore.create({ configDir, cwd: opts.cwd, model }),
    history: [],
    usage: {},
  });
  if (opts.resume === undefined) return fresh();
  const id =
    opts.resume.type === "id" ? opts.resume.id : await latestSessionId(configDir, opts.cwd);
  if (id === null) {
    notice("No previous session for this directory; starting a new one.");
    return fresh();
  }
  const store = SESSION_ID_PATTERN.test(id)
    ? await SessionStore.load(configDir, opts.cwd, id)
    : null;
  if (store === null) {
    throw new GaharError(`Session not found: ${id}`, { code: "session_not_found" });
  }
  const parsed = await readSessionEvents(store.eventsPath);
  if (parsed.repaired) notice("Recovered an interrupted tool call batch from the previous run.");
  if (store.getMeta().model !== model) await store.setModel(model);
  return { store, history: parsed.messages, usage: parsed.usage };
}

export function requireApiKey(config: ResolvedConfig): string {
  if (config.apiKey) return config.apiKey;
  throw new GaharError(
    "No OpenRouter API key configured. Run: gahar auth login or set OPENROUTER_API_KEY",
    {
      code: "no_api_key",
      exitCode: 3,
    },
  );
}
