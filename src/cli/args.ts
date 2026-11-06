import type { PermissionMode } from "../contracts/config.js";
import { BINARY_NAME } from "../shared/defaults.js";
import { VERSION } from "../shared/version.js";

export interface CliOptions {
  model?: string;
  permissionMode?: PermissionMode;
  json: boolean;
  continue: boolean;
  resume?: string;
  noUpdateCheck: boolean;
  debug: boolean;
  noColor: boolean;
  maxTokens?: number;
  quiet: boolean;
}

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; prompt: string | null; options: CliOptions }
  | { kind: "command"; name: string; args: string[]; options: CliOptions }
  | { kind: "error"; message: string };

export const EXIT_ARG_ERROR = 2;
export const EXIT_AUTH_ERROR = 3;
export const EXIT_INTERRUPT = 130;

const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edit", "full-auto"];

const VALUE_FLAGS = new Map<string, string>([
  ["--model", "model"],
  ["-m", "model"],
  ["--permission-mode", "permission-mode"],
  ["--max-tokens", "max-tokens"],
]);

/** Session ids look like 20261107-123456-abcd1234 (see session/store newSessionId). */
const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/i;

const BOOL_FLAGS = new Map<string, string>([
  ["--json", "json"],
  ["-c", "continue"],
  ["--continue", "continue"],
  ["--no-update-check", "noUpdateCheck"],
  ["--debug", "debug"],
  ["--no-color", "noColor"],
  ["--quiet", "quiet"],
  ["-q", "quiet"],
]);

const COMMANDS = new Set(["setup", "auth", "model", "sessions", "doctor", "update", "help"]);

export function defaultOptions(): CliOptions {
  return {
    json: false,
    continue: false,
    noUpdateCheck: false,
    debug: false,
    noColor: false,
    quiet: false,
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options = defaultOptions();
  const positionals: string[] = [];
  let printPrompt: string | null = null;
  let sawPrint = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v" || arg === "-V") return { kind: "version" };
    if (arg === "--yolo") {
      options.permissionMode = "full-auto";
      continue;
    }
    if (arg === "-r" || arg === "--resume") {
      const next = argv[index + 1];
      if (next !== undefined && SESSION_ID_PATTERN.test(next)) {
        options.resume = next;
        index += 1;
      } else {
        options.continue = true;
      }
      continue;
    }
    if (arg === "-p" || arg === "--print") {
      const next = argv[index + 1];
      if (next === undefined) return error(`missing value for ${arg}`);
      printPrompt = next;
      sawPrint = true;
      index += 1;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    if (flag === "--resume" && inline !== undefined) {
      if (inline.trim() === "") return error("missing value for --resume");
      options.resume = inline;
      continue;
    }
    const valueKey = VALUE_FLAGS.get(flag);
    if (valueKey !== undefined) {
      const value = inline ?? argv[index + 1];
      if (value === undefined) return error(`missing value for ${flag}`);
      if (inline === undefined) index += 1;
      const applied = applyValue(options, valueKey, value);
      if (typeof applied === "string") return error(applied);
      continue;
    }
    const boolKey = BOOL_FLAGS.get(flag);
    if (boolKey !== undefined) {
      if (inline !== undefined) return error(`${flag} does not take a value`);
      if (boolKey === "json") options.json = true;
      else if (boolKey === "continue") options.continue = true;
      else if (boolKey === "noUpdateCheck") options.noUpdateCheck = true;
      else if (boolKey === "debug") options.debug = true;
      else if (boolKey === "noColor") options.noColor = true;
      else if (boolKey === "quiet") options.quiet = true;
      continue;
    }
    const inCommand = positionals[0] !== undefined && COMMANDS.has(positionals[0]);
    if (arg.startsWith("-") && arg !== "-" && !inCommand) return error(`unknown option: ${flag}`);
    positionals.push(arg);
  }

  const head = positionals[0];
  if (head !== undefined && COMMANDS.has(head)) {
    if (head === "help") return { kind: "help" };
    return { kind: "command", name: head, args: positionals.slice(1), options };
  }
  if (sawPrint) return { kind: "run", prompt: printPrompt, options };
  if (positionals.length > 0) return { kind: "run", prompt: positionals.join(" "), options };
  return { kind: "run", prompt: null, options };
}

function applyValue(options: CliOptions, key: string, value: string): string | undefined {
  if (key === "model") {
    if (value.trim() === "") return "missing value for --model";
    options.model = value;
    return undefined;
  }
  if (key === "permission-mode") {
    if (!PERMISSION_MODES.includes(value as PermissionMode)) {
      return `invalid permission mode: ${value} (expected ask, auto-edit or full-auto)`;
    }
    options.permissionMode = value as PermissionMode;
    return undefined;
  }
  if (key === "max-tokens") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return `invalid value for --max-tokens: ${value} (expected a positive integer)`;
    }
    options.maxTokens = parsed;
    return undefined;
  }
  return undefined;
}

function error(message: string): ParsedArgs {
  return { kind: "error", message: `${message}\n\n${shortUsage()}` };
}

export function shortUsage(): string {
  return [
    `Usage: ${BINARY_NAME} [options] [prompt]`,
    `Try '${BINARY_NAME} --help' for more information.`,
  ].join("\n");
}

export function helpText(): string {
  return [
    `${BINARY_NAME} ${VERSION} - agentic coding CLI for your terminal, powered by OpenRouter.`,
    "",
    "Usage:",
    `  ${BINARY_NAME}                          start the interactive session (REPL)`,
    `  ${BINARY_NAME} "fix the failing test"`,
    `  ${BINARY_NAME} -p "summarize this repo"  run one prompt and exit`,
    `  ${BINARY_NAME} <command> [args]`,
    "",
    "Options:",
    "  -p, --print <text>          run a single prompt non-interactively",
    "  -m, --model <id>            model to use (e.g. anthropic/claude-sonnet-4.6)",
    "      --permission-mode <m>   ask | auto-edit | full-auto (default: ask)",
    "      --yolo                  alias for --permission-mode full-auto",
    "      --max-tokens <n>        maximum tokens per model response",
    "      --json                  emit JSONL events on stdout, logs on stderr",
    "  -c, --continue              resume the most recent session in this project",
    "  -r, --resume [id]           resume a session by id, or the latest one",
    "      --no-update-check       skip the release update check",
    "      --no-color              disable colored output",
    "      --debug                 verbose diagnostics on stderr",
    "  -q, --quiet                 suppress the banner and non-essential output",
    "  -v, --version               print the version and exit",
    "  -h, --help                  print this help and exit",
    "",
    "Commands:",
    "  setup                       configure the API key and default model",
    "  auth login|status|logout    manage the OpenRouter API key",
    "  model list|set <id>|show    inspect and choose models",
    "  sessions list|show|rm       manage saved sessions",
    "  doctor                      diagnose the installation",
    "  update [--check] [--force]  update to the latest release",
    "  help                        print this help",
    "",
    "Examples:",
    `  ${BINARY_NAME} auth login`,
    `  ${BINARY_NAME} -p "list the TODOs in src" --json`,
    `  ${BINARY_NAME} -c --permission-mode auto-edit`,
    `  ${BINARY_NAME} model set openai/gpt-5.1-codex`,
  ].join("\n");
}

export function versionText(): string {
  return `${BINARY_NAME} ${VERSION}`;
}
