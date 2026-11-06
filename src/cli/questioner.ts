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
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  close(): void;
  readonly interactive: boolean;
}

export function createQuestioner(options: QuestionerOptions & { interactive: boolean }): Questioner {
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
    rl ??= createInterface({ input: process.stdin, output: options.stderr as NodeJS.WritableStream });
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
      return nextAnswer();
    },
    async confirm(question: string, fallback = false): Promise<boolean> {
      options.stderr.write(question);
      const answer = (await nextAnswer()).trim().toLowerCase();
      if (answer === "") return fallback;
      return answer === "y" || answer === "yes";
    },
    close(): void {
      if (rl !== null) {
        rl.close();
        rl = null;
      }
    },
  };
}
