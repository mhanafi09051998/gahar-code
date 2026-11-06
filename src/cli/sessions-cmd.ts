import type { ChatMessage } from "../contracts/messages.js";
import type { SessionSummary } from "../contracts/session.js";
import { sessionEventsPath } from "../session/project.js";
import { listSessions, readSessionEvents } from "../session/store.js";
import { removePath } from "../shared/fsx.js";
import { truncateLine } from "../ui/render.js";
import { EXIT_ARG_ERROR } from "./args.js";
import type { CommandIO } from "./auth-cmd.js";

export interface SessionsDeps {
  configDir: string;
  cwd: string;
}

const SHOWN_MESSAGES = 6;

export async function runSessions(
  args: readonly string[],
  deps: SessionsDeps,
  io: CommandIO,
): Promise<number> {
  const [action = "list", id] = args;
  if (action === "list") return sessionsList(deps, io);
  if (action !== "show" && action !== "rm") {
    io.err(`unknown sessions action: ${action} (expected list, show <id> or rm <id>)`);
    return EXIT_ARG_ERROR;
  }
  if (id === undefined) {
    io.err(`usage: gahar sessions ${action} <id>`);
    return EXIT_ARG_ERROR;
  }
  // Ids are only resolved against the listed sessions, so a crafted id cannot escape the store.
  const session = (await listSessions(deps.configDir, deps.cwd)).find((item) => item.id === id);
  if (session === undefined) {
    io.err(`no session ${id} in this project. Run: gahar sessions list`);
    return 1;
  }
  if (action === "rm") {
    await removePath(session.path);
    io.out(`removed session ${id}`);
    return 0;
  }
  return sessionsShow(session, io);
}

async function sessionsList(deps: SessionsDeps, io: CommandIO): Promise<number> {
  const sessions = await listSessions(deps.configDir, deps.cwd);
  if (sessions.length === 0) {
    io.out("no sessions in this project yet");
    return 0;
  }
  for (const session of sessions) io.out(formatSessionRow(session));
  return 0;
}

export function formatSessionRow(session: SessionSummary): string {
  const updated = session.updatedAt.replace("T", " ").slice(0, 16);
  return `${session.id}  ${updated}  ${truncateLine(session.title, 40).padEnd(40)}  ${session.cwd}`;
}

async function sessionsShow(session: SessionSummary, io: CommandIO): Promise<number> {
  io.out(`id:       ${session.id}`);
  io.out(`title:    ${session.title}`);
  io.out(`model:    ${session.model}`);
  io.out(`cwd:      ${session.cwd}`);
  io.out(`created:  ${session.createdAt}`);
  io.out(`updated:  ${session.updatedAt}`);
  io.out(`messages: ${session.messageCount}`);
  const { messages } = await readSessionEvents(sessionEventsPath(session.path));
  const recent = messages.filter((message) => message.role !== "system").slice(-SHOWN_MESSAGES);
  if (recent.length > 0) io.out("");
  for (const message of recent) io.out(formatMessage(message));
  return 0;
}

export function formatMessage(message: ChatMessage): string {
  const text = (message.content ?? "").replace(/\s+/g, " ").trim();
  const tools = message.tool_calls?.map((call) => call.function.name).join(", ");
  const body = text !== "" ? text : tools ? `(tool calls: ${tools})` : "(empty)";
  return `${message.role.padEnd(9)} ${truncateLine(body, 100)}`;
}
