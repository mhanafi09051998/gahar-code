import type { JsonSchema } from "../contracts/messages.js";
import type { TodoItem, TodoStatus } from "../contracts/todo.js";
import { TODO_STATUSES } from "../contracts/todo.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import { ArgError, asRecord, invalidArguments } from "./args.js";
import { objectSchema, stringProperty } from "./schema.js";

const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

export function parseTodoList(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) throw new ArgError(`"todos" must be an array`);
  return input.map((item, index) => {
    const record = asRecord(item, `todos[${index}]`);
    const content = record.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ArgError(`todos[${index}].content must be a non-empty string`);
    }
    if (!isStatus(record.status)) {
      throw new ArgError(`todos[${index}].status must be one of ${TODO_STATUSES.join(", ")}`);
    }
    return { content: content.trim(), status: record.status };
  });
}

function countByStatus(todos: readonly TodoItem[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}

export function formatTodoList(todos: readonly TodoItem[]): string {
  const counts = countByStatus(todos);
  const header = `${todos.length} item(s): ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed`;
  const lines = todos.map((todo, index) => `${index + 1}. ${MARKERS[todo.status]} ${todo.content}`);
  return [header, ...lines].join("\n");
}

export class TodoWriteTool implements Tool {
  readonly name = "todo_write";
  readonly description =
    "Create or update the visible task list. Send the complete list each time; each item has content and a status.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      todos: {
        type: "array",
        description: "The complete task list.",
        items: objectSchema(
          {
            content: stringProperty("Short description of the task."),
            status: { type: "string", enum: [...TODO_STATUSES] },
          },
          ["content", "status"],
        ),
      },
    },
    ["todos"],
  );

  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const todos = parseTodoList(asRecord(rawArgs, this.name).todos);
      ctx.todos.replace(todos);
      return {
        ok: true,
        output: formatTodoList(todos),
        summary: `${todos.length} todos (${countByStatus(todos).completed} done)`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const todoWriteTool = new TodoWriteTool();
