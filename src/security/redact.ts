const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_MASK = "-----BEGIN PRIVATE KEY----- [redacted] -----END PRIVATE KEY-----";

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-or-[A-Za-z0-9_-]{8,}/g, "sk-or-***"],
  [/github_pat_[A-Za-z0-9_]{10,}/g, "github_pat_***"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "gh*_***"],
  [/xox[abposr]-[A-Za-z0-9-]{8,}/g, "xox*-***"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA***"],
  [PRIVATE_KEY_BLOCK, PRIVATE_KEY_MASK],
];

const SHORT_SECRET_MIN = 8;

/**
 * Masks credentials so they can never reach a log, event stream, or transcript.
 * Cheap by design: a handful of precompiled regexes and an early return.
 */
export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  if (text.length === 0) return text;
  let output = text;
  let touched = false;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(output)) continue;
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
    touched = true;
  }
  for (const secret of extraSecrets) {
    if (typeof secret !== "string" || secret.length < SHORT_SECRET_MIN) continue;
    if (!output.includes(secret)) continue;
    output = output.split(secret).join("***");
    touched = true;
  }
  return touched ? output : text;
}
