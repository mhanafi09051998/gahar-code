#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { runCli } from "./cli/main.js";
import { toErrorMessage } from "./shared/errors.js";

/** Entry point: returns the process exit code instead of exiting. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, { createApp: async (options) => createApp(options) });
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${toErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
