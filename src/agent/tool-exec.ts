import { abortError } from "../api/errors.js";
import {
  createEvent,
  type GaharEvent,
  type ToolResultEvent,
  type ToolUseEvent,
} from "../contracts/events.js";
import type { ToolCall } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolRegistry, ToolResult } from "../contracts/tools.js";
import { MAX_TOOL_OUTPUT_CHARS } from "../shared/defaults.js";
import { isAbortError, toErrorMessage } from "../shared/errors.js";
import { truncateMiddle } from "../shared/truncate.js";

export const READ_ONLY_CONCURRENCY = 4;

export interface ToolExecDeps {
  tools: ToolRegistry;
  emit: (event: GaharEvent) => void;
  buildToolContext: (signal: AbortSignal) => ToolContext;
  now: () => number;
}

export interface ToolOutcome {
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export type ParsedArguments = { ok: true; value: unknown } | { ok: false; error: string };

export function parseArguments(raw: string | undefined): ParsedArguments {
  const text = (raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Runs read-only tools with bounded concurrency, then mutating/unknown tools in order. */
export async function executeToolCalls(
  deps: ToolExecDeps,
  calls: ToolCall[],
  signal: AbortSignal,
): Promise<ToolOutcome[]> {
  const outcomes: ToolOutcome[] = new Array(calls.length);
  const readOnly: number[] = [];
  const sequential: number[] = [];
  calls.forEach((call, index) => {
    if (deps.tools.get(call.function.name)?.readOnly) readOnly.push(index);
    else sequential.push(index);
  });
  const runAt = async (index: number): Promise<void> => {
    const call = calls[index];
    if (call) outcomes[index] = await executeOne(deps, call, signal);
  };
  await runPool(readOnly, READ_ONLY_CONCURRENCY, runAt);
  for (const index of sequential) {
    if (signal.aborted) throw abortError();
    await runAt(index);
  }
  return outcomes;
}

async function runPool(
  items: number[],
  concurrency: number,
  worker: (item: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (let item = items[cursor++]; item !== undefined; item = items[cursor++]) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

type PreparedCall = { tool: Tool; args: unknown } | { tool: null; args: unknown; error: string };

/** Resolves the tool and parses its arguments without throwing. */
function prepare(tools: ToolRegistry, call: ToolCall): PreparedCall {
  const name = call.function.name;
  const raw = call.function.arguments;
  const tool = tools.get(name);
  if (!tool) {
    const available = tools
      .list()
      .map((item) => item.name)
      .join(", ");
    return { tool: null, args: raw, error: `Unknown tool: ${name}. Available tools: ${available}` };
  }
  const parsed = parseArguments(raw);
  if (!parsed.ok) {
    return { tool: null, args: raw, error: `Invalid JSON arguments for ${name}: ${parsed.error}` };
  }
  return { tool, args: parsed.value };
}

/** Executes one call; unknown tools, bad JSON and tool exceptions become error results. */
async function executeOne(
  deps: ToolExecDeps,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const started = deps.now();
  const name = call.function.name;
  const prepared = prepare(deps.tools, call);
  deps.emit(
    createEvent<ToolUseEvent>({ type: "tool_use", id: call.id, name, args: prepared.args }),
  );
  let result: ToolResult;
  if (prepared.tool === null) {
    result = { ok: false, output: prepared.error };
  } else {
    try {
      result = await prepared.tool.execute(prepared.args, deps.buildToolContext(signal));
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw abortError();
      result = { ok: false, output: `Tool ${name} failed: ${toErrorMessage(error)}` };
    }
  }
  const output = truncateMiddle(result.output ?? "", MAX_TOOL_OUTPUT_CHARS, "tool output").text;
  const durationMs = deps.now() - started;
  deps.emit(
    createEvent<ToolResultEvent>({
      type: "tool_result",
      id: call.id,
      name,
      ok: result.ok,
      output,
      durationMs,
    }),
  );
  return { call, result: { ...result, output }, durationMs };
}
