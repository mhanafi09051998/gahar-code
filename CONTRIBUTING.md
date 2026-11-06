# Contributing

Thanks for helping improve Gahar Code.

## Development setup

```sh
git clone https://github.com/mhanafi09051998/gahar-code.git
cd gahar-code
npm ci
npm run build
node dist/cli.js --help
```

Requires Node.js 20.3 or newer. Use `npm link` to try the `gahar` binary globally.

## Checks

```sh
npm run check        # biome, typecheck, file size limit, build and tests
npm run secret-scan  # must pass before every commit
```

- Tests use `node:test`, live in `test/**/*.test.mjs` and import the compiled code from `dist/`.
- Tests never touch the real network: use a local `http.createServer` mock or an injected `fetch`.
- Source, test and script files stay at or under 300 lines. Split by responsibility.
- Never commit a real key. Use obvious placeholders such as `sk-or-v1-test`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `chore:`.
- Keep pull requests focused, describe the behavior change and how you tested it, and update
  `CHANGELOG.md` under `[Unreleased]`.
- CI must be green on Linux, Windows and macOS.

## Adding a tool

1. Create `src/tools/<name>.ts` implementing the `Tool` interface from `src/contracts/tools.ts`:
   name, description, JSON schema parameters, `readOnly` and `execute`.
2. Validate arguments with the helpers in `src/tools/args.ts`; return `{ ok: false, output }`
   with an actionable message instead of throwing, and truncate output with `src/shared/truncate.ts`.
3. Route every write, shell or network action through the permission gate in `src/security/`.
4. Add it to `builtinTools` in `src/tools/registry.ts` and export it from `src/tools/index.ts`.
5. Add tests under `test/unit/tools/` and document it in the README if it is user facing.

## Releasing (maintainers)

1. Update `version` in `package.json` and move `[Unreleased]` entries in `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag. The release workflow builds, packs and publishes
   `gahar-code.tgz` and its `.sha256` file.
