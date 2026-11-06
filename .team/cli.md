# Brief: cli-tui (teammate)

You implement the command line surface of "Gahar Code", an agentic coding CLI (Node 20+, ESM, TypeScript strict). Project root: C:\Users\Win10\Music\Gahar Code

## Hard rules
- Read src/contracts/*.ts and src/shared/*.ts FIRST. They are frozen; do not edit them. Ask the lead for contract changes.
- Only write files inside your write scope:
  src/cli/**, src/ui/**, src/cli.ts, test/unit/cli/**
- Max 300 lines per file. ESM NodeNext: relative imports MUST end in .js. Use "import type" for types. No enums.
- Dependencies available: picocolors, diff, fast-glob, node builtins. No new deps.
- Tests use node:test against COMPILED output (import from "../../../dist/....js"). Run: npm run build; node --test test/unit/cli/<file>.test.mjs
- Do NOT run npm install, git commit, or write outside your scope. Do NOT create the app wiring (src/app.ts) - the lead owns it. Import the runner factory from "../app.js" with EXACTLY this shape:
  import { createApp } from "../app.js";
  const app = await createApp({ cwd, config, approvals, events, resume });
  app.sessionId, app.meta, app.getUsage(), app.runTurn(input, signal), app.compact(), app.undo(), app.setModel(model), app.close()
  (AppOptions/App/TurnResult live in contracts/runner.ts.)

## What to build

### src/cli/args.ts
- parseArgs(argv): a pure, testable parser producing a discriminated union: {kind:"help"} | {kind:"version"} | {kind:"run", prompt, options} | {kind:"command", name, args, options} | {kind:"error", message}.
- Global flags: --model <id>, --permission-mode ask|auto-edit|full-auto, --yolo (alias full-auto), --json, -c/--continue, -r/--resume [id], --no-update-check, --debug, --no-color, --max-tokens <n>, --version, -v, --help, -h.
- Positional prompt: gahar -p "prompt", gahar --print "prompt", gahar "prompt". A bare "gahar" with no prompt starts the REPL.
- Subcommands: setup, auth (login|status|logout), model (list|set <id>|show), sessions (list|show <id>|rm <id>), doctor, update [--check] [--force], help.
- Unknown flags => {kind:"error"} with a helpful message. Missing values for flags that need them => error. Exit code 2 for argument errors, 3 for auth/config errors, 130 for interrupt.
- Also export helpText() and versionText().

### src/ui/render.ts, src/ui/prompt.ts, src/ui/approval.ts, src/ui/banner.ts, src/ui/update-notifier.ts
- render.ts: responsive streaming text renderer honoring NO_COLOR/--no-color (picocolors with a manual override), a spinner for "thinking" while nothing is streamed, tool call lines ("-> read_file src/app.ts"), collapsible tool result summaries (first 3 lines + N more), a diff renderer with +/- coloring, an error renderer, and a cost/usage line. Everything goes to stderr in --json mode; stdout is reserved for JSONL events.
- prompt.ts: readline-based line editor with history (<configDir>/history.txt, last 200 entries), "> " prompt, multi-line paste tolerance, Ctrl+C handling (first press aborts the running turn, second press at an empty prompt exits with 130), Ctrl+D exits cleanly. Must work when stdin is not a TTY (then a single read).
- approval.ts: ApprovalHandler implementation. Prints the request (title, resource, diff or command) and asks [y]es / [a]lways (session) / [n]o with a default of no; in --json or non-TTY it returns "deny" immediately without printing a prompt. Never throws.
- banner.ts: short startup banner with version, model, cwd (kept to a few lines, suppressed in --json/quiet).
- update-notifier.ts: non-blocking check; prints a single stderr line "Update available: 0.2.0 -> run: gahar update" at most once per 24h. It imports { checkForUpdate } from "../update/check.js" (owned by the release teammate) - if that module or the network fails, silently do nothing. Never delay startup more than 3s and never crash.

### src/cli/setup.ts, src/cli/auth-cmd.ts, src/cli/model-cmd.ts, src/cli/sessions-cmd.ts, src/cli/doctor.ts, src/cli/json-output.ts, src/cli/headless.ts
- json-output.ts: JsonEventWriter that serializes GaharEvent objects to stdout as JSONL and is a no-op-safe wrapper in non-json mode.
- headless.ts: runHeadless(...) for gahar -p/-print and --json: build the app, run one turn, write the final text to stdout (or JSONL events), exit 0/1/3/130. In non-TTY without full-auto it must not hang: mutations are denied by the gate, and the run still completes.
- setup.ts: first-run wizard: validate an existing key or prompt for one (hidden input, never echoed), validate against /key, list the top tool-capable models with prices/context (use shared/defaults.ts recommendations plus the live catalog), let the user pick or accept the default, then write the global config. Must be usable non-interactively via env vars for tests.
- auth-cmd.ts: auth login (prompt/validate/save), auth status (source, masked key, /key usage), auth logout (remove apiKey).
- model-cmd.ts: model list (markdown-ish table: id, context, in/out price, recommended marker), model set <id> (validate the id exists in the catalog before writing), model show.
- sessions-cmd.ts: sessions list (id, updated, title, cwd), sessions show <id> (meta + last messages), sessions rm <id>.
- doctor.ts: checks Node version, config dir writability, key presence + /key validation (skipped gracefully when offline), model validity, git availability, shell availability (pwsh/powershell/bash), network reachability to OpenRouter, global install location, and whether a newer release exists. Prints PASS/WARN/FAIL lines and exits 1 only when a FAIL is found.

### src/ui/repl.ts and src/cli.ts
- repl.ts: the interactive loop: banner, prompt, streaming render, tool lines, approval prompts, slash commands (/help /model [id] /auth /init /compact /clear /undo /cost /status /permissions [mode] /verbose /exit). /init writes an AGENTS.md stub describing the project when missing. Unknown slash command prints help. Ctrl+C during a turn aborts that turn only. Auto-compaction notice.
- cli.ts: shebang "#!/usr/bin/env node", main(argv) dispatcher: parse args, load config (import { loadConfig } from "./config/store.js"), resolve the key, build the approval handler, create the app, dispatch to repl/headless/commands, map GaharError.exitCode to process.exitCode, and install SIGINT/SIGTERM handlers that abort the running turn (exit 130). No top-level await outside a main().catch.

## Deliverable
Full CLI + UI, plus unit tests under test/unit/cli/ covering: arg parsing matrix (every flag, aliases, errors, exit codes), help/version text, prompt history persistence, approval handler defaults and non-TTY denial, json writer output shape, doctor check aggregation with mocked probes, slash command dispatch table, setup flow with injected fake client/config.

## Evidence required in your final report
- exact commands run with exit status and passing test count
- list of files created
- any contract change you needed (ask the lead)