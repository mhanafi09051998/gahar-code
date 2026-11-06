import type { JsonSchema } from "../contracts/messages.js";
import type { Tool, ToolContext, ToolResult } from "../contracts/tools.js";
import type { TodoItem } from "../contracts/todo.js";
import { asRecord, invalidArguments } from "./args.js";
import { objectSchema } from "./schema.js";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function parseTodoList(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) {
    throw new Error("todos must be an array");
  }
  return input.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`todos[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const content = record.content;
    const status = record.status;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`todos[${index}].content must be a non-empty string`);
    }
    if (typeof status !== "string" || !STATUSES.has(status)) {
      throw new Error(`todos[${index}].status must be one of pending, in_progress, completed`);
    }
    const parsed: TodoItem = { content: content.trim(), status: status as TodoItem["status"] };
    const activeForm = record.activeForm;
    if (typeof activeForm === "string" && activeForm.length > 0) parsed.activeForm = activeForm;
    return parsed;
  });
}

export function formatTodoList(todos: readonly TodoItem[]): string {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  const marker: Record<TodoItem["status"], string> = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]",
  };
  const lines = todos.map((todo, index) => `${index + 1}. ${marker[todo.status]} ${todo.content}`);
  const header = `${todos.length} item(s): ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed`;
  return `${header}\n${lines.join("\n")}`;
}

export class TodoWriteTool implements Tool {
  readonly name = "todo_write";
  readonly description = "Create or update the visible task list. Send the complete list each time; each item has content and a status.";
  readonly readOnly = false;
  readonly parameters: JsonSchema = objectSchema(
    {
      todos: {
        type: "array",
        description: "The complete task list.",
        items: objectSchema(
          {
            content: { type: "string", description: "Short description of the task." },
            activeForm: { type: "string", description: "Present-continuous label shown while the task runs." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          ["content", "status"],
        ),
      },
    },
    ["todos"],
  );

  async execute(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const args = asRecord(rawArgs, this.name);
      const todos = parseTodoList(args.todos);
      _ctx.todos.replace(todos);
      const counts = { pending: 0, in_progress: 0, completed: 0 };
      for (const todo of todos) counts[todo.status] += 1;
      return {
        ok: true,
        output: formatTodoList(todos),
        summary: `${todos.length} todos (${counts.completed} done)`,
      };
    } catch (error) {
      return invalidArguments(this.name, error);
    }
  }
}

export const todoWriteTool = new TodoWriteTool();
