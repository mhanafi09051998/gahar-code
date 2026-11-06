export type PermissionMode = "ask" | "auto-edit" | "full-auto";

export interface GaharConfig {
  version: 1;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  updateCheck?: boolean;
  contextCompaction?: boolean;
  showReasoning?: boolean;
}

export interface ProjectConfig {
  model?: string;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  contextCompaction?: boolean;
  showReasoning?: boolean;
}

export interface ResolvedConfig {
  cwd: string;
  configDir: string;
  apiKey: string | null;
  apiKeySource: "env" | "config" | "none";
  model: string;
  maxTokens: number;
  permissionMode: PermissionMode;
  updateCheck: boolean;
  contextCompaction: boolean;
  showReasoning: boolean;
  baseUrl: string;
  debug: boolean;
  noColor: boolean;
  warnings: string[];
}

export interface ConfigOverrides {
  model?: string;
  permissionMode?: PermissionMode;
  maxTokens?: number;
  debug?: boolean;
  noColor?: boolean;
  baseUrl?: string;
  configDir?: string;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  globalPath: string;
  projectPath: string | null;
  globalConfig: GaharConfig;
  projectConfig: ProjectConfig | null;
}
