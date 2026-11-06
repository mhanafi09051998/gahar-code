import { toErrorMessage } from "../shared/errors.js";
import type { CommandIO } from "./auth-cmd.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Everything doctor touches outside the process, injectable for tests. */
export interface DoctorProbes {
  nodeVersion: string;
  configDir: string;
  apiKey: string | null;
  model: string;
  checkConfigDirWritable(): Promise<void>;
  /** Resolves true when OpenRouter answers at all. */
  networkReachable(): Promise<boolean>;
  validateKey(key: string): Promise<unknown>;
  /** Resolves null when the catalog could not be fetched. */
  modelExists(model: string): Promise<boolean | null>;
  commandAvailable(command: string): Promise<boolean>;
  installLocation(): string | null;
  /** Resolves null when the release check could not run. */
  latestVersion(): Promise<{ current: string; latest: string; newer: boolean } | null>;
}

const MIN_NODE_MAJOR = 20;
const SHELLS = ["pwsh", "powershell", "bash"] as const;

function pass(name: string, detail: string): CheckResult {
  return { name, status: "PASS", detail };
}
function warn(name: string, detail: string): CheckResult {
  return { name, status: "WARN", detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, status: "FAIL", detail };
}

export async function runChecks(probes: DoctorProbes): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const major = Number.parseInt(probes.nodeVersion.replace(/^v/, ""), 10);
  results.push(
    major >= MIN_NODE_MAJOR
      ? pass("node", probes.nodeVersion)
      : fail("node", `${probes.nodeVersion} (requires >= ${MIN_NODE_MAJOR})`),
  );
  results.push(
    await guarded("config dir", async () => {
      await probes.checkConfigDirWritable();
      return pass("config dir", `${probes.configDir} is writable`);
    }),
  );
  const online = await probes.networkReachable().catch(() => false);
  results.push(
    online
      ? pass("network", "openrouter.ai reachable")
      : warn("network", "openrouter.ai unreachable"),
  );
  results.push(await checkKey(probes, online));
  results.push(await checkModel(probes, online));
  results.push(
    (await probes.commandAvailable("git").catch(() => false))
      ? pass("git", "available")
      : warn("git", "not found on PATH"),
  );
  results.push(await checkShell(probes));
  const install = probes.installLocation();
  results.push(install ? pass("install", install) : warn("install", "location unknown"));
  results.push(await checkRelease(probes));
  return results;
}

async function guarded(name: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (error) {
    return fail(name, toErrorMessage(error));
  }
}

async function checkKey(probes: DoctorProbes, online: boolean): Promise<CheckResult> {
  const key = probes.apiKey;
  if (key === null || key === "") return fail("api key", "not configured. Run: gahar auth login");
  if (!online) return warn("api key", "present; validation skipped (offline)");
  return guarded("api key", async () => {
    await probes.validateKey(key);
    return pass("api key", "valid");
  });
}

async function checkModel(probes: DoctorProbes, online: boolean): Promise<CheckResult> {
  if (!online) return warn("model", `${probes.model}; catalog check skipped (offline)`);
  const exists = await probes.modelExists(probes.model).catch(() => null);
  if (exists === null) return warn("model", `${probes.model}; catalog unavailable`);
  return exists
    ? pass("model", probes.model)
    : fail("model", `${probes.model} not in the catalog. Run: gahar model list`);
}

async function checkShell(probes: DoctorProbes): Promise<CheckResult> {
  for (const shell of SHELLS) {
    if (await probes.commandAvailable(shell).catch(() => false)) return pass("shell", shell);
  }
  return warn("shell", "no pwsh, powershell or bash found; run_command may fail");
}

async function checkRelease(probes: DoctorProbes): Promise<CheckResult> {
  const release = await probes.latestVersion().catch(() => null);
  if (release === null) return warn("release", "could not check for updates");
  return release.newer
    ? warn("release", `${release.latest} available (current ${release.current}). Run: gahar update`)
    : pass("release", `${release.current} is the latest`);
}

export function formatChecks(results: readonly CheckResult[]): string[] {
  const width = Math.max(...results.map((result) => result.name.length));
  return results.map(
    (result) => `${result.status.padEnd(4)}  ${result.name.padEnd(width)}  ${result.detail}`,
  );
}

/** Exit status: 1 only when at least one check failed. */
export function doctorExitCode(results: readonly CheckResult[]): number {
  return results.some((result) => result.status === "FAIL") ? 1 : 0;
}

export async function runDoctor(probes: DoctorProbes, io: CommandIO): Promise<number> {
  const results = await runChecks(probes);
  for (const line of formatChecks(results)) io.out(line);
  return doctorExitCode(results);
}
