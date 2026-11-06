# Instructions for AI agents

This file guides AI coding agents (including Gahar Code itself) working on this repository.

## Project

Gahar Code is an agentic coding CLI, TypeScript ESM (NodeNext), Node.js 20 or newer. The binary
`gahar` is `dist/cli.js`. Runtime dependencies are limited to `diff`, `fast-glob` and
`picocolors`; do not add new ones without a strong reason.

## Layout

- `src/contracts/`: shared types between modules. Treat them as frozen; change them only on purpose
  and update every implementation in the same change.
- `src/shared/`: constants (`defaults.ts`), errors, file helpers, truncation, version. Reuse these
  instead of writing new helpers.
- `src/cli/`, `src/agent/`, `src/api/`, `src/tools/`, `src/security/`, `src/session/`,
  `src/config/`, `src/auth/`, `src/update/`, `src/ui/`: one responsibility per directory.
- `test/unit/<area>/*.test.mjs`: `node:test` suites that import compiled code from `dist/`.
- `scripts/`: file size check, test runner and secret scan.

## Invariants

- Maximum 300 lines per source, test or script file. Split by responsibility.
- Relative imports end in `.js`. No enums. TypeScript strict with `noUncheckedIndexedAccess`.
- Tests run against `dist/`: `npm run build` first, then `node --test test/unit/<area>/<file>.test.mjs`.
- Tests never call real services. Use a local `http.createServer` mock or an injected `fetch`/spawn.
- Never write a real credential anywhere. Use placeholders such as `sk-or-v1-test`.
  `npm run secret-scan` must pass.
- Release asset names are fixed: `gahar-code.tgz` and `gahar-code.tgz.sha256`
  (`RELEASE_ASSET_NAME` in `src/shared/defaults.ts` and `.github/workflows/release.yml`).
- Every write, shell or network action goes through the permission gate.

## Before you finish

```sh
npm run check
npm run secret-scan
```

Remove dead code, unused imports and debug output in the files you touched.
