/** Small, defensive argument readers so a bad tool call returns a message instead of throwing. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export function asRecord(input: unknown, tool: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArgError(`${tool} expects a JSON object of arguments`);
  }
  return input as Record<string, unknown>;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ArgError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ArgError(`"${key}" must be a string when provided`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ArgError(`"${key}" must be a boolean when provided`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArgError(`"${key}" must be a finite number when provided`);
  }
  return value;
}

export function requireArray(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ArgError(`"${key}" is required and must be a non-empty array`);
  }
  return value;
}

export function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const floored = Math.floor(value);
  if (!Number.isFinite(floored)) return fallback;
  return Math.min(Math.max(floored, min), max);
}

export function invalidArguments(tool: string, error: unknown): { ok: false; output: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, output: `invalid arguments: ${message} (${tool})` };
}

export function failure(tool: string, message: string): { ok: false; output: string } {
  return { ok: false, output: `${tool}: ${message}` };
}

export function ok(output: string, detail?: string): { ok: true; output: string; detail?: string } {
  return detail === undefined ? { ok: true, output } : { ok: true, output, detail };
}
