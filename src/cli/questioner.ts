import { createInterface } from "node:readline/promises";
import type { Writable } from "./env.js";

export interface QuestionerOptions {
  stderr: Writable;
  /** Injectable answer source for tests / non-interactive runs. */
  answers?: readonly string[];
  /** Called when the scripted answers run out (interactive fallback). */
  onPrompt?: () => Promise<string>;
}

export interface Questioner {
  ask(question: string): Promise<string>;
  hidden(question: string): Promise<string>;
  close(): void;
  readonly interactive: boolean;
}

export function createQuestioner(
  options: QuestionerOptions & { interactive: boolean },
): Questioner {
  let index = 0;
  let rl: ReturnType<typeof createInterface> | null = null;
  const answers = options.answers ?? [];

  const nextAnswer = async (): Promise<string> => {
    if (index < answers.length) {
      const value = answers[index] ?? "";
      index += 1;
      return value;
    }
    if (options.onPrompt !== undefined) return options.onPrompt();
    if (options.answers !== undefined) return "";
    if (!options.interactive) return "";
    rl ??= createInterface({
      input: process.stdin,
      output: options.stderr as NodeJS.WritableStream,
    });
    return await rl.question("");
  };

  return {
    interactive: options.interactive,
    async ask(question: string): Promise<string> {
      options.stderr.write(question);
      return nextAnswer();
    },
    async hidden(question: string): Promise<string> {
      options.stderr.write(question);
      const scripted = index < answers.length || options.onPrompt !== undefined;
      if (scripted || !options.interactive || !process.stdin.isTTY) return nextAnswer();
      return readHiddenLine(options.stderr);
    },
    close(): void {
      if (rl !== null) {
        rl.close();
        rl = null;
      }
    },
  };
}

/** Reads one line from a TTY in raw mode without echoing it (for API keys). */
function readHiddenLine(stderr: Writable): Promise<string> {
  const stdin = process.stdin;
  return new Promise<string>((resolve) => {
    let value = "";
    const finish = (result: string): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n" || char === "\u0004" || char === "\u0003") {
          finish(char === "\u0003" ? "" : value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
