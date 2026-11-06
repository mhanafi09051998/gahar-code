export const APP_NAME = "Gahar Code";
export const BINARY_NAME = "gahar";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
export const RECOMMENDED_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.1-codex",
  "google/gemini-3.1-pro-preview",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4.1-flash",
] as const;
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const GITHUB_REPO = "mhanafi09051998/gahar-code";
export const RELEASE_ASSET_NAME = "gahar-code.tgz";
export const RELEASE_ASSET_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/${RELEASE_ASSET_NAME}`;
export const HTTP_REFERER = `https://github.com/${GITHUB_REPO}`;
export const X_TITLE = APP_NAME;
export const MAX_TOOL_OUTPUT_CHARS = 30000;
export const MAX_READ_LINES = 2000;
export const MAX_ITERATIONS = 40;
