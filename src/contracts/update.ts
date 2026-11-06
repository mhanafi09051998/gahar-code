export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotesUrl?: string;
  publishedAt?: string;
}

export interface UpdateCheckOptions {
  repo?: string;
  timeoutMs?: number;
  allowCache?: boolean;
}

export interface PerformUpdateOptions {
  force?: boolean;
  checkOnly?: boolean;
  onLog?: (line: string) => void;
}

export interface PerformUpdateResult {
  updated: boolean;
  currentVersion: string;
  latestVersion: string;
  message: string;
}
