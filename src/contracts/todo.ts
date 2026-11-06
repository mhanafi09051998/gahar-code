import type { TodoItem } from "./events.js";

export type { TodoItem };

export type TodoStatus = TodoItem["status"];

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
