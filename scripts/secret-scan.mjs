#!/usr/bin/env node
// Scans the repository for committed credentials. Prints "file:line: pattern"
// for each finding (never the matched value) and exits 1 when anything is found.
// A line can opt out with the marker "secret-scan: allow" (use for fixtures only).
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".claude"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const MAX_BYTES = 2 * 1024 * 1024;
const CONFIG_EXTENSIONS = new Set([
  ".env",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
]);
const ALLOW_MARKER = "secret-scan: allow";
const FAKE_VALUE =
  /test|fake|example|dummy|placeholder|sample|redacted|changeme|your[_-]?|x{6,}|\*{4,}|\.\.\./i;

const PATTERNS = [
  { name: "openrouter-api-key", regex: /\bsk-or-(?:v1-)?[A-Za-z0-9_-]{20,}/g },
  { name: "openai-style-api-key", regex: /\bsk-(?!or-)(?:[a-z]+-)*[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { name: "github-fine-grained-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: "aws-access-key-id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // A PEM header that ends the line, or is followed by an escaped newline and key data.
  {
    name: "private-key-block",
    regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:["'`,]?\s*$|\\n[A-Za-z0-9+/])/g,
  },
];

const ASSIGNMENT = {
  name: "generic-secret-assignment",
  regex:
    /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-/+=.]{24,})/gi,
};

function isConfigLike(path) {
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.startsWith(".env") || CONFIG_EXTENSIONS.has(extname(base).toLowerCase());
}

function isFake(value) {
  const tail = value.split(/[-_]/).pop() ?? "";
  return FAKE_VALUE.test(value) || /^(.)\1{7,}$/.test(tail);
}

/** Tracked plus untracked-but-not-ignored files, or a directory walk without git. */
async function listFiles() {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  if (git.status === 0) return git.stdout.split("\0").filter((path) => path !== "");
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative(root, full));
    }
  }
  await walk(root);
  return found;
}

function shouldSkip(path) {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => SKIP_DIRS.has(part)) || SKIP_FILES.has(parts.at(-1) ?? "");
}

function scanLine(line, configLike) {
  if (line.includes(ALLOW_MARKER)) return [];
  const hits = new Set();
  for (const { name, regex } of PATTERNS) {
    for (const match of line.matchAll(regex)) {
      if (name === "private-key-block" || !isFake(match[0])) hits.add(name);
    }
  }
  if (configLike) {
    for (const match of line.matchAll(ASSIGNMENT.regex)) {
      if (!isFake(match[1] ?? "")) hits.add(ASSIGNMENT.name);
    }
  }
  return [...hits];
}

async function scanFile(path) {
  const full = join(root, path);
  const info = await stat(full).catch(() => null);
  if (info === null || !info.isFile() || info.size > MAX_BYTES) return [];
  const buffer = await readFile(full);
  if (buffer.includes(0)) return [];
  const configLike = isConfigLike(path);
  const findings = [];
  buffer
    .toString("utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      for (const name of scanLine(line, configLike)) {
        findings.push(`${path.split(sep).join("/")}:${index + 1}: ${name}`);
      }
    });
  return findings;
}

const files = (await listFiles()).filter((path) => !shouldSkip(path));
const findings = (await Promise.all(files.map(scanFile))).flat();
if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(
    `secret-scan: ${findings.length} potential secret(s) found. Remove them and rotate the keys.`,
  );
  process.exit(1);
}
console.log(`secret-scan: ${files.length} file(s) scanned, no secrets found.`);
