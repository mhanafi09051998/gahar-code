# Brief: release-docs (teammate)

You implement the update system, CI/CD, and documentation of "Gahar Code", an agentic coding CLI (Node 20+, ESM, TypeScript strict). Project root: C:\Users\Win10\Music\Gahar Code
GitHub target: public repo mhanafi09051998/gahar-code, binary "gahar", package "gahar-code".

## Hard rules
- Read src/contracts/*.ts, src/shared/*.ts and src/shared/defaults.ts FIRST. Frozen; ask the lead for changes.
- Only write files inside your write scope:
  src/update/**, scripts/secret-scan.mjs, test/unit/update/**, .github/**, README.md, README.id.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, AGENTS.md, .env.example
  Do NOT touch scripts/run-tests.mjs or scripts/check-file-size.mjs (they exist already).
- Max 300 lines per file. ESM NodeNext: relative imports end in .js. No enums, no new dependencies.
- Tests use node:test against COMPILED output (import from "../../../dist/....js"). Run: npm run build; node --test test/unit/update/<file>.test.mjs
- Do NOT run npm install, git commit/push, gh, or create the release. The lead does GitHub operations. NEVER write a credential anywhere.
- The release workflow must not need any repository secret: it uses the default GITHUB_TOKEN with permissions: contents: write.

## What to build

### src/update/semver.ts, src/update/check.ts, src/update/install.ts
- semver.ts: parse/compare/gt/valid for versions with optional prerelease and build metadata; isNewer(a, b).
- check.ts: checkForUpdate(options): GET https://api.github.com/repos/<repo>/releases/latest (repo default from shared/defaults.ts GITHUB_REPO), headers User-Agent + Accept, timeout 3s (AbortSignal.timeout with a fallback), returns UpdateCheckResult (contracts/update.ts). Cache the result at <configDir>/cache/update.json with a 24h TTL and honor GAHAR_NO_UPDATE_CHECK and the allowCache option. All failures return null instead of throwing (the caller must never crash), but checkForUpdateOrThrow() is exported for "gahar update --check" where a failure must be reported. Never print or store a token; unauthenticated GitHub API calls only (the repo is public).
- install.ts: performUpdate(options) implementing:
  1. resolve the latest release (or throw a clear error),
  2. if not newer than the installed version and not force, report "already up to date" and stop,
  3. download the asset named exactly gahar-code.tgz (RELEASE_ASSET_NAME) from the release to a temp dir,
  4. download gahar-code.tgz.sha256 and verify the checksum; refuse to install on mismatch,
  5. run "npm install -g --force <tarball>" with stdio inherit, using the same npm executable that is running the CLI when possible (process.env.npm_config_user_agent / process.execPath heuristics must not break on Windows),
  6. verify the installed version by spawning "gahar --version" (or the resolved binary path) and compare with the downloaded version,
  7. return PerformUpdateResult with a precise, actionable message; on failure explain the manual command (npm install -g https://github.com/mhanafi09051998/gahar-code/releases/latest/download/gahar-code.tgz).
  onLog callback streams progress lines to the CLI. Everything must be testable by injecting a fake fetch/spawn (export the internal seams).

### .github/workflows/ci.yml, .github/workflows/release.yml, .github/workflows/codeql.yml, .github/dependabot.yml
- ci.yml: on push/PR to main; matrix node 20/22/24 across ubuntu-latest, windows-latest, macos-latest; steps: checkout, setup-node with cache npm, npm ci, npx biome check ., npm run typecheck, npm run check:size, npm run secret-scan, npm test. Timeout 20 minutes, concurrency cancel-in-progress.
- release.yml: on push tag "v*.*.*"; permissions contents: write; verify the tag equals package.json version; npm ci; npm run check; npm run build; npm pack; rename the tarball to gahar-code.tgz; generate gahar-code.tgz.sha256 (sha256sum on Linux) with the format "<hash>  gahar-code.tgz" (sha256sum -c compatible); gh release create "$TAG" --title "Gahar Code $TAG" --generate-notes gahar-code.tgz gahar-code.tgz.sha256. The asset names must match RELEASE_ASSET_NAME exactly.
- codeql.yml: javascript-typescript analysis on push/PR/weekly.
- dependabot.yml: npm + github-actions weekly.

### scripts/secret-scan.mjs
- Scans the whole repo (excluding node_modules, .git, dist, package-lock.json data lines) for: sk-or-... keys, OpenRouter/OpenAI style keys, github_pat_/ghp_/gho_/ghs_ tokens, AWS AKIA keys, private key blocks, and generic "api_key = <long string>" assignments in config-like files. Prints file:line: pattern-name ONLY (never the matched value) and exits 1 on findings. Must pass on the current tree (verify by running it).

### README.md, README.id.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, AGENTS.md, .env.example
- README.md (English, primary): what Gahar Code is (agentic coding CLI in the terminal, OpenRouter-powered), one-line install from the GitHub release asset, quick start (gahar auth login, gahar setup, gahar, gahar -p "..."), how to keep it updated ("gahar update", "gahar update --check", and the Releases page link so other people notice new versions), permissions/safety model, all CLI flags and slash commands in a table, configuration and environment variables, cost/token reporting, troubleshooting, architecture summary, contributing, license. Include a badges section (CI + license + Node version) and the exact npm install -g command. Be accurate: only document flags that exist in the CLI brief (src/cli/args.ts).
- README.id.md: a concise Indonesian version of the same content (install, quick start, update, permission modes, config, troubleshooting).
- CHANGELOG.md: Keep a Changelog format with an [Unreleased] section and [0.1.0] - 2026-11-07 listing the features actually built.
- SECURITY.md: how to report a vulnerability privately (GitHub Security Advisories), the local-only data model (no telemetry, key stored in ~/.gahar/config.json or env), and what the CLI never uploads.
- CONTRIBUTING.md: dev setup, npm run check, commit conventions, PR expectations, how to add a tool.
- CODE_OF_CONDUCT.md: Contributor Covenant 2.1 short form.
- AGENTS.md: instructions for AI agents working on this repo (structure, invariants: contracts frozen, 300-line limit, tests against dist, no secrets).
- .env.example: OPENROUTER_API_KEY= placeholder plus the GAHAR_* variables, with a comment that it is never committed with real values.
- Add a "powered by dsh" badge/section only if you are told to; skip it otherwise.

## Deliverable
Update system + CI + docs, plus unit tests under test/unit/update/ covering: semver compare and prerelease ordering, update check parsing/caching/expiry/TTL + no-update-check env, failure returns null, install flow with injected fake fetch + fake spawn (up-to-date, checksum mismatch, success, npm failure), asset URL construction. Add a test that reads .github/workflows/release.yml and asserts the asset name gahar-code.tgz, the checksum file, and contents: write are present.

## Evidence required in your final report
- exact commands run with exit status and passing test count (including: node scripts/secret-scan.mjs)
- list of files created
- confirmation that no secret value appears in any file you wrote