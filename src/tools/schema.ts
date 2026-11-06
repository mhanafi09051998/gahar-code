import type { JsonSchema } from "../contracts/messages.js";

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

export function numberProperty(description: string): Record<string, unknown> {
  return { type: "number", description };
}

export function booleanProperty(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

export function arrayProperty(
  description: string,
  items: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "array", description, items };
}
