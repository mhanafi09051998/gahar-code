# Brief: tools-security (teammate)

You implement the tool layer and security guards of "Gahar Code", an agentic coding CLI (Node 20+, ESM, TypeScript strict). Project root: C:\Users\Win10\Music\Gahar Code

## Hard rules
- Read src/contracts/*.ts and src/shared/*.ts FIRST. They are frozen; do not edit them. Ask the lead for contract changes.
- Only write files inside your write scope:
  src/tools/**, src/security/**, test/unit/tools/**
- Max 300 lines per file. ESM NodeNext: relative imports MUST end in .js. Use "import type" for types. No enums.
- Runtime deps allowed: fast-glob, picocolors, diff. Prefer node builtins. No new deps without asking the lead.
- Tests use node:test against COMPILED output: import from "../../../dist/....js". Run: npm run build; node --test test/unit/tools/<file>.test.mjs
- Do NOT run npm install, git commit, or write outside your scope.

## What to build

### src/security/paths.ts - PathGuard implementation (contracts/tools.ts)
- resolveForRead / resolveForWrite map an input path (relative to cwd or absolute) to a ResolvedPath {abs, input, inside, exists, type}.
- Reject (with a clear error) Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), NUL bytes, and paths escaping the workspace by traversal. Symlink/junction escape: realpath the nearest existing ancestor and verify it is still inside the workspace; on Windows also treat junctions like symlinks. Reading outside the workspace is allowed only through the permission gate (the gate lives in security/permissions.ts), never silently.
- relative(abs) returns a workspace-relative POSIX-ish path for display; isInside(abs) uses path containment with a trailing separator guard (never "C:\foo" matching "C:\foobar").
- Cross-platform: Windows drive letters, UNC paths, and POSIX roots must all work. Use path.win32/path.posix appropriately; do not hardcode separators.

### src/security/permissions.ts - PermissionGate implementation
- Modes: ask (default), auto-edit (writes inside the workspace auto-allowed, shell still asks), full-auto (everything allowed).
- ensure(request, signal): returns {allowed, reason?}. Rules: read-only tools never ask; write inside workspace asks unless mode is auto-edit/full-auto; shell always asks unless full-auto; any path outside the workspace always asks regardless of mode; network (fetch_url) asks unless full-auto.
- "allow-session" decisions are remembered per resource key for the rest of the session (in-memory set).
- If there is no interactive approval handler available (non-TTY, --json, headless) and the tool is not read-only, DENY by default with a reason explaining how to allow it (--permission-mode full-auto or --yolo). Never hang.
- ApprovalHandler implementation for the CLI (interactive prompt) is NOT yours: the CLI teammate owns it. You own the gate + an in-memory decision cache.

### src/security/redact.ts
- redactSecrets(text, extraSecrets): mask sk-or-*, github_pat_*, ghp_*, gho_*, ghs_*, xox*-*, AKIA[0-9A-Z]{16}, "-----BEGIN ... PRIVATE KEY-----" blocks, and any exact secret value supplied by the caller (the configured API key). Keep it cheap: precompiled regexes, early return when nothing matches.

### src/tools/* - one file per tool, plus registry.ts
Implement class-based tools matching the Tool interface (name/description/parameters/readOnly/execute). Every tool: validate args defensively (return {ok:false, output:"invalid arguments: ..."} instead of throwing), truncate output with shared/truncate.ts, and include an actionable error message.
- read_file: offset/limit, line numbers in output, MAX_READ_LINES, 100 KB cap, binary detection (refuse with a clear message), record the read in FileRegistry.
- write_file: create or overwrite; if the file exists it MUST have been read first (FileRegistry.assertFresh) else return an error telling the model to read it; snapshot before writing (SnapshotStore.capture); report bytes written and create/update.
- edit_file: literal old_string -> new_string, require uniqueness (error listing match count when not unique), optional replace_all, read-before-write, snapshot before writing, and include a unified diff (use the diff package) in the output, truncated.
- multi_edit: array of edits applied atomically to one file; validate all first, write once, single diff.
- list_dir: entries with type/size, skip .git/node_modules by default, max depth 1 unless depth is provided (cap depth 3, cap 500 entries).
- glob: fast-glob, pattern + optional cwd, follow .gitignore by default (fast-glob option), 200 results max, skip node_modules unless the pattern asks for it.
- grep: ripgrep-like search over files matched by fast-glob include (default all), regex validated by new RegExp (return a clear error on bad regex), case-insensitive option, 250 matches, skip binary/oversized files (>1 MB), show file:line: text.
- run_command: shell execution. Windows: prefer pwsh if found on PATH else powershell.exe with -NoProfile -NonInteractive -Command, force UTF-8 ([Console]::OutputEncoding), kill the whole process tree with taskkill /PID <pid> /T /F on timeout/abort. POSIX: /bin/bash -lc (fall back to /bin/sh). Timeout default 120s, cap 600s, output cap 30 KB (use truncateMiddle), include the exit code in the output, and support a declared cwd.
- fetch_url: http/https only, block localhost/private/link-local/metadata IPs (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10) including after DNS resolution and after redirects (max 5 redirects), 15s timeout, 50 KB text cap, strip HTML tags for readability but keep code blocks, user-agent "gahar-code/<version>".
- todo_write: stores a todo list through ctx.todos; validate items (status enum).
- registry.ts: createDefaultRegistry() returning a ToolRegistry with all tools; get(name), list(), definitions() producing ToolDefinition[] in a stable order.

## Deliverable
All tools + guards, plus unit tests under test/unit/tools/ covering: path escape and device name rejection, workspace containment edge cases ("C:\foobar" vs "C:\foo"), permission matrix in all three modes, non-interactive denial, allow-session memory, redaction of each pattern, read/edit/write happy path and read-before-write violation, edit uniqueness failure, multi_edit atomicity, binary refusal, truncation limits, glob/grep limits, run_command success/failure/timeout (use a real short-lived command like node -e), fetch_url SSRF guard rejection, todo validation.

## Evidence required in your final report
- exact commands run with exit status and passing test count
- list of files created
- any contract change you needed (ask the lead)