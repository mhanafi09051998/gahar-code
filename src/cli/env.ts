import process from "node:process";
import { defaultConfigDir } from "../config/paths.js";

/** Minimal write surface used by the CLI so tests can capture output. */
export interface Writable {
  write(chunk: string): unknown;
}

export interface CliEnv {
  argv: string[];
  cwd: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  isTTY: boolean;
  columns: number;
  now: () => number;
}

export interface PartialCliEnv {
  argv?: string[];
  cwd?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  isTTY?: boolean;
  columns?: number;
  now?: () => number;
}

export function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function createEnv(partial: PartialCliEnv = {}): CliEnv {
  const env = partial.env ?? process.env;
  const stdinIsTTY = partial.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = partial.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  return {
    argv: partial.argv ?? process.argv.slice(2),
    cwd: partial.cwd ?? process.cwd(),
    configDir: partial.configDir ?? defaultConfigDir(env),
    env,
    stdout: partial.stdout ?? process.stdout,
    stderr: partial.stderr ?? process.stderr,
    stdinIsTTY,
    stdoutIsTTY,
    isTTY: partial.isTTY ?? (stdinIsTTY && stdoutIsTTY),
    columns: partial.columns ?? process.stderr.columns ?? 80,
    now: partial.now ?? (() => Date.now()),
  };
}

export function isJsonMode(env: CliEnv, json: boolean): boolean {
  return json || truthy(env.env.GAHAR_JSON);
}

export function noColor(env: CliEnv, flag: boolean): boolean {
  return flag || env.env.NO_COLOR !== undefined || truthy(env.env.GAHAR_NO_COLOR);
}
