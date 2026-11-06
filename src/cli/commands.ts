import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../contracts/runner.js";
import { pathExists } from "../shared/fsx.js";
import { formatCost } from "../ui/render.js";

export interface CommandContext {
  app: App;
  cwd: string;
  args: string[];
  /** Whether OPENROUTER_API_KEY is set in the environment. */
  envKey: boolean;
  setVerbose: (value: boolean) => void;
  verbose: boolean;
  clearScreen: () => void;
  requestExit: () => void;
  print: (line: string) => void;
}

export interface SlashCommand {
  name: string;
  summary: string;
  usage?: string;
  run(ctx: CommandContext): Promise<void> | void;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/help",
    summary: "show this list of commands",
    run: (ctx) => ctx.print(helpLines().join("\n")),
  },
  {
    name: "/model",
    summary: "show or set the active model",
    usage: "/model [id]",
    run: (ctx) => {
      const id = ctx.args.join(" ").trim();
      if (id === "") {
        ctx.print(`model: ${ctx.app.meta.model}`);
        return;
      }
      ctx.app.setModel(id);
      ctx.print(`model set to ${id}`);
    },
  },
  {
    name: "/auth",
    summary: "show the API key source and status",
    run: (ctx) => {
      ctx.print(
        ctx.envKey
          ? "auth: using OPENROUTER_API_KEY from the environment"
          : "auth: key loaded from the config file; run 'gahar auth status' for details",
      );
    },
  },
  {
    name: "/init",
    summary: "create an AGENTS.md stub for this project",
    run: async (ctx) => {
      const target = join(ctx.cwd, "AGENTS.md");
      if (await pathExists(target)) {
        ctx.print(`AGENTS.md already exists at ${target}`);
        return;
      }
      await writeFile(target, agentsStub(ctx), "utf8");
      ctx.print(`wrote ${target}`);
    },
  },
  {
    name: "/compact",
    summary: "compact the conversation history",
    run: async (ctx) => {
      await ctx.app.compact();
      ctx.print("history compacted");
    },
  },
  {
    name: "/clear",
    summary: "clear the screen",
    run: (ctx) => ctx.clearScreen(),
  },
  {
    name: "/undo",
    summary: "restore the files changed by the previous turn",
    run: async (ctx) => {
      const restored = await ctx.app.undo();
      ctx.print(restored ? "restored files from the previous turn" : "nothing to undo");
    },
  },
  {
    name: "/cost",
    summary: "show tokens and cost for this session",
    run: (ctx) => {
      const usage = ctx.app.getUsage();
      const cost = typeof usage.cost === "number" ? formatCost(usage.cost) : "unknown";
      ctx.print(
        `tokens: ${usage.total_tokens ?? 0} (prompt ${usage.prompt_tokens ?? 0}, completion ${
          usage.completion_tokens ?? 0
        }) · cost ${cost}`,
      );
    },
  },
  {
    name: "/status",
    summary: "show session, model and usage",
    run: (ctx) => {
      const usage = ctx.app.getUsage();
      ctx.print(
        [
          `session  ${ctx.app.sessionId}`,
          `title    ${ctx.app.meta.title}`,
          `model    ${ctx.app.meta.model}`,
          `cwd      ${ctx.cwd}`,
          `messages ${ctx.app.meta.messageCount}`,
          `tokens   ${usage.total_tokens ?? 0}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "/permissions",
    summary: "show or change the permission mode",
    usage: "/permissions [ask|auto-edit|full-auto]",
    run: (ctx) => {
      const mode = ctx.args[0];
      if (mode === undefined) {
        ctx.print(
          "permission mode: ask | auto-edit | full-auto (change with 'gahar --permission-mode')",
        );
        return;
      }
      ctx.print(`permission mode is set at startup: restart with --permission-mode ${mode}`);
    },
  },
  {
    name: "/verbose",
    summary: "toggle reasoning output",
    run: (ctx) => {
      const next = !ctx.verbose;
      ctx.setVerbose(next);
      ctx.print(`verbose ${next ? "on" : "off"}`);
    },
  },
  {
    name: "/exit",
    summary: "leave the session",
    run: (ctx) => ctx.requestExit(),
  },
  {
    name: "/quit",
    summary: "alias for /exit",
    run: (ctx) => ctx.requestExit(),
  },
];

export function findCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((command) => command.name === name);
}

export function parseSlashInput(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head = "", ...rest] = trimmed.split(/\s+/);
  return { name: head, args: rest };
}

/**
 * Runs a slash command. Returns false when the input is not a slash command;
 * unknown commands print a warning plus the command list.
 */
export async function dispatchSlash(
  input: string,
  base: Omit<CommandContext, "args">,
): Promise<boolean> {
  const parsed = parseSlashInput(input);
  if (parsed === null) return false;
  const command = findCommand(parsed.name);
  if (command === undefined) {
    base.print(`unknown command ${parsed.name}\n${helpLines().join("\n")}`);
    return true;
  }
  await command.run({ ...base, args: parsed.args });
  return true;
}

export function helpLines(): string[] {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length)) + 2;
  return [
    "Commands:",
    ...SLASH_COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    "  Anything else is sent to the model.",
  ];
}

function agentsStub(ctx: CommandContext): string {
  return [
    "# AGENTS.md",
    "",
    "Project instructions for Gahar Code and other coding agents.",
    "",
    "## Project",
    `- Root: ${ctx.cwd}`,
    "- Package manager: npm",
    "- Language: TypeScript (ESM, strict)",
    "",
    "## Commands",
    "- Build: npm run build",
    "- Typecheck: npm run typecheck",
    "- Test: npm test",
    "- Lint/format: npx biome check .",
    "",
    "## Conventions",
    "- Keep modules small (300 lines max) and typed.",
    "- Never commit secrets; use environment variables.",
    "- Update tests together with behavior changes.",
    "",
  ].join("\n");
}
